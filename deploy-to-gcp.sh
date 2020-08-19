#! /bin/bash

set -e

echo "Login to gcloud and select project"

GCLOUD_PROJECT_ID="professionalserviceslabs"
GCLOUD_ZONE="europe-west3-a"

gcloud config set project "$GCLOUD_PROJECT_ID"
gcloud config set compute/zone "$GCLOUD_ZONE"

echo "Build images and push to gcr"

PROJECT_NAME="commercetools-adyen-integration"

#gcloud auth configure-docker

EXTENSION_IMAGE="${PROJECT_NAME}-extension"
NOTIFICATION_IMAGE="${PROJECT_NAME}-notification"
GCR_PATH="eu.gcr.io/${GCLOUD_PROJECT_ID}"
EXTENSION_IMAGE_FULL="${GCR_PATH}/${EXTENSION_IMAGE}"
NOTIFICATION_IMAGE_FULL="${GCR_PATH}/${NOTIFICATION_IMAGE}"
TAG="v5.0.0"

docker build -t "$EXTENSION_IMAGE" ./extension
docker tag "$EXTENSION_IMAGE" "$EXTENSION_IMAGE_FULL:$TAG"
docker push -- "$EXTENSION_IMAGE_FULL"

docker build -t "$NOTIFICATION_IMAGE" ./notification
docker tag "$NOTIFICATION_IMAGE" "$NOTIFICATION_IMAGE_FULL:$TAG"
docker push -- "$NOTIFICATION_IMAGE_FULL"

## 2. Download helm charts
HELM_CHARTS_REPO="https://github.com/commercetools/k8s-charts.git"
HELM_CHARTS_VERSION="1.7.5"

printf "\n- Cloning commercetools/k8s-charts repo..\n"
git clone --branch="$HELM_CHARTS_VERSION" --depth=1 "$HELM_CHARTS_REPO"/

# 2. Connect to the gcloud cluster
GCLOUD_CLUSTER_NAME="adyen-demo"

printf "\n- Connecting to the gcloud cluster with name: [%s] in [%s]..\n" "$GCLOUD_CLUSTER_NAME" "$GCLOUD_ZONE"
gcloud container clusters get-credentials "$GCLOUD_CLUSTER_NAME" --zone="$GCLOUD_ZONE"

#
## 3. Decrypt secrets
#./extension/k8s/crypt/crypt.sh
#./notification/k8s/crypt/crypt.sh
#

# init tiller for cluster
#kubectl -n kube-system create serviceaccount tiller
#kubectl create clusterrolebinding tiller --clusterrole cluster-admin --serviceaccount=kube-system:tiller
#helm init --service-account tiller

echo "Upgrading helm for extension module"
cd k8s-charts/charts/public-service

ENVIRONMENT_NAME="demo"
helm upgrade --install \
    --namespace $ENVIRONMENT_NAME \
    commercetools-adyen-integration-extension \
    -f ./../../../extension/k8s/values.yaml \
    -f ./../../../extension/k8s/$ENVIRONMENT_NAME/values.yaml \
    -f ./../../../extension/k8s/$ENVIRONMENT_NAME/secrets.yaml \
    .

echo "Upgrading helm for notification module"
helm upgrade --install \
    --namespace $ENVIRONMENT_NAME \
    commercetools-adyen-integration-notification \
    -f ./../../../notification/k8s/values.yaml \
    -f ./../../../notification/k8s/$ENVIRONMENT_NAME/values.yaml \
    -f ./../../../notification/k8s/$ENVIRONMENT_NAME/secrets.yaml \
    .

# 5. Print info about current cluster state
printf "Current cluster state:\n"
printf "Helms:\n%s\n\n" "$(helm list)"
printf "Deployments:\n%s\n\n" "$(kubectl get deployments)"
printf "Cronjobs:\n%s\n\n" "$(kubectl get cronjobs)"
printf "Pods:\n%s\n\n" "$(kubectl get pods)"
