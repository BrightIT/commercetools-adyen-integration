const _ = require('lodash')
const Promise = require('bluebird')
const { serializeError } = require('serialize-error')
const ctp = require('../../utils/ctp')
const { validateHmacSignature } = require('../../utils/hmacValidator')
const adyenEvents = require('../../../resources/adyen-events')
const logger = require('../../utils/logger').getLogger()
const config = require('../../config/config')()

async function processNotifications (notifications, ctpClient) {
  await Promise.map(notifications,
    notification => processNotification(notification, ctpClient),
    { concurrency: 10 })
}

async function processNotification (notification, ctpClient) {
  if (config.adyen.enableHmacSignature) {
    const errorMessage = validateHmacSignature(notification)
    if (errorMessage) {
      logger.error(`HMAC validation failed. Reason: "${errorMessage}". Notification: ${JSON.stringify(notification)}`)
      return
    }
  }

  const merchantReference = _.get(notification, 'NotificationRequestItem.merchantReference', null)
  if (merchantReference === null) {
    logger.error(`Can't extract merchantReference from the notification: ${JSON.stringify(notification)}`)
    return
  }

  const payment = await getPaymentByMerchantReference(merchantReference, ctpClient)
  if (payment !== null)
    await updatePaymentWithRepeater(payment, notification, ctpClient)
  else
    logger.error(`Payment with merchantReference: ${merchantReference} was not found`)
}

async function updatePaymentWithRepeater (payment, notification, ctpClient) {
  const maxRetry = 20
  let currentPayment = payment
  let currentVersion = payment.version
  let retryCount = 0
  let retryMessage
  let updateActions
  while (true) {
    updateActions = calculateUpdateActionsForPayment(currentPayment, notification)
    try {
      /* eslint-disable-next-line no-await-in-loop */
      await ctpClient.update(ctpClient.builder.payments, currentPayment.id, currentVersion, updateActions)
      logger.debug(`Payment with key ${currentPayment.key} was successfully updated`)
      break
    } catch (err) {
      if (err.body.statusCode !== 409)
        throw new Error(`Unexpected error during updating a payment with ID: ${currentPayment.id}. Exiting. `
          + `Error: ${JSON.stringify(serializeError(err))}`)
      retryCount += 1
      if (retryCount > maxRetry) {
        retryMessage = 'Got a concurrent modification error'
          + ` when updating payment with id "${currentPayment.id}".`
          + ` Version tried "${currentVersion}",`
          + ` currentVersion: "${err.body.errors[0].currentVersion}".`
        throw new Error(`${retryMessage} Won't retry again`
          + ` because of a reached limit ${maxRetry}`
          + ` max retries. Error: ${JSON.stringify(serializeError(err))}`)
      }
      /* eslint-disable-next-line no-await-in-loop */
      const response = await ctpClient.fetchById(ctpClient.builder.payments, currentPayment.id)
      currentPayment = response.body // eslint-disable-line prefer-destructuring
      currentVersion = currentPayment.version
    }
  }
}

function calculateUpdateActionsForPayment (payment, notification) {
  const updateActions = []
  const notificationRequestItem = notification.NotificationRequestItem
  const stringifiedNotification = JSON.stringify(notification)
  // check if the interfaceInteraction is already on payment or not
  const isNotificationInInterfaceInteraction = payment.interfaceInteractions.some(
    interaction => interaction.fields.notification === stringifiedNotification
  )
  if (isNotificationInInterfaceInteraction === false)
    updateActions.push(getAddInterfaceInteractionUpdateAction(notification))

  const {
    transactionType,
    transactionState
  } = getTransactionTypeAndStateOrNull(notificationRequestItem)
  if (transactionType !== null) {
    // if there is already a transaction with type `transactionType` then update its `transactionState` if necessary,
    // otherwise create a transaction with type `transactionType` and state `transactionState`
    const { pspReference } = notificationRequestItem
    const oldTransaction = _.find(payment.transactions, transaction => transaction.interactionId === pspReference)
    if (_.isEmpty(oldTransaction))
      updateActions.push(getAddTransactionUpdateAction({
        type: transactionType,
        state: transactionState,
        amount: notificationRequestItem.amount.value,
        currency: notificationRequestItem.amount.currency,
        interactionId: pspReference
      }))
    else if (ctp.compareTransactionStates(oldTransaction.state, transactionState) > 0)
      updateActions.push(getChangeTransactionStateUpdateAction(oldTransaction.id, transactionState))
  }
  return updateActions
}

function getAddInterfaceInteractionUpdateAction (notification) {
  // strip away sensitive data
  delete notification.additionalData
  delete notification.reason

  const eventCode = _.isNil(notification.NotificationRequestItem.eventCode)
    ? '' : notification.NotificationRequestItem.eventCode.toLowerCase()

  return {
    action: 'addInterfaceInteraction',
    type: {
      key: 'ctp-adyen-integration-interaction-notification',
      typeId: 'type'
    },
    fields: {
      createdAt: new Date(),
      status: eventCode,
      type: 'notification',
      notification: JSON.stringify(notification)
    }
  }
}

function getChangeTransactionStateUpdateAction (transactionId, newTransactionState) {
  return {
    action: 'changeTransactionState',
    transactionId,
    state: newTransactionState
  }
}

function getTransactionTypeAndStateOrNull (notificationRequestItem) {
  const adyenEventCode = notificationRequestItem.eventCode
  const adyenEventSuccess = notificationRequestItem.success

  // eslint-disable-next-line max-len
  const adyenEvent = _.find(adyenEvents, e => e.eventCode === adyenEventCode && e.success === adyenEventSuccess)
  if (adyenEvent && adyenEventCode === 'CANCEL_OR_REFUND') {
    /* we need to get correct action from the additional data, for example:
     "NotificationRequestItem":{
        "additionalData":{
           "modification.action":"refund"
        }
        ...
      }
     */
    const modificationAction = notificationRequestItem.additionalData
      ? notificationRequestItem.additionalData['modification.action'] : null
    if (modificationAction === 'refund')
      adyenEvent.transactionType = 'Refund'
    else if (modificationAction === 'cancel')
      adyenEvent.transactionType = 'CancelAuthorization'
  }
  return adyenEvent || {
    eventCode: adyenEventCode,
    success: adyenEventSuccess,
    transactionType: null,
    transactionState: null
  }
}

function getAddTransactionUpdateAction ({
  type, state, amount, currency, interactionId
}) {
  return {
    action: 'addTransaction',
    transaction: {
      type,
      amount: {
        currencyCode: currency,
        centAmount: amount
      },
      state,
      interactionId
    }
  }
}

async function getPaymentByMerchantReference (merchantReference, ctpClient) {
  try {
    const result = await ctpClient.fetchByKey(ctpClient.builder.payments, merchantReference)
    return result.body
  } catch (err) {
    if (err.statusCode === 404) return null
    throw Error(`Failed to fetch a payment with merchantReference: ${merchantReference}. `
    + `Error: ${JSON.stringify(serializeError(err))}`)
  }
}

module.exports = { processNotifications }
