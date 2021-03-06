const { makePayment } = require('../service/web-component-service')
const pU = require('./payment-utils')
const c = require('../config/constants')

async function execute (paymentObject) {
  const makePaymentRequestObj = JSON.parse(paymentObject.custom.fields.makePaymentRequest)
  const { request, response } = await makePayment(makePaymentRequestObj)
  const actions = [
    pU.createAddInterfaceInteractionAction({
      request, response, type: c.CTP_INTERACTION_TYPE_MAKE_PAYMENT
    }),
    pU.createSetCustomFieldAction(c.CTP_CUSTOM_FIELD_MAKE_PAYMENT_RESPONSE, response)
  ]

  if (!paymentObject.key)
    actions.push({
      action: 'setKey',
      key: request.reference.toString() // ensure the key is a string
    })

  const addTransactionAction = pU.createAddTransactionActionByResponse(
    paymentObject.amountPlanned.centAmount,
    paymentObject.amountPlanned.currencyCode,
    response
  )

  if (addTransactionAction)
    actions.push(addTransactionAction)

  return {
    actions
  }
}

module.exports = { execute }
