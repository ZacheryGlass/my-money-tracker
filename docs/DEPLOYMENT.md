# Azure Deployment Runbook

End-to-end deploy of `my-money-tracker` to Azure. Issues #22, #23, #24, #25.

**Prereqs:** Azure account, [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az --version`), repo admin on GitHub.

```bash
az login
az account set --subscription "<your-subscription-id>"
```

---

## Variables (set once in your shell)

```bash
RG=mymoney-rg
LOC=eastus
PG_SERVER=mymoney-pg                 # globally unique
PG_ADMIN=mmadmin
PG_PASSWORD='<strong-password>'      # save in a password manager
DB_NAME=my_money
APP_NAME=mymoney-api                 # globally unique; becomes mymoney-api.azurewebsites.net
SWA_NAME=mymoney-web
PLAN=mymoney-plan
```

---

## Issue #22 — PostgreSQL Flexible Server

```bash
az group create -n $RG -l $LOC

az postgres flexible-server create \
  --resource-group $RG \
  --name $PG_SERVER \
  --location $LOC \
  --admin-user $PG_ADMIN \
  --admin-password "$PG_PASSWORD" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --backup-retention 7 \
  --public-access 0.0.0.0   # allows Azure services; restrict further later

az postgres flexible-server db create \
  --resource-group $RG \
  --server-name $PG_SERVER \
  --database-name $DB_NAME

# Allow your local IP for psql access
MYIP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create \
  --resource-group $RG --name $PG_SERVER \
  --rule-name myip --start-ip-address $MYIP --end-ip-address $MYIP

# Test
psql "host=$PG_SERVER.postgres.database.azure.com port=5432 dbname=$DB_NAME user=$PG_ADMIN sslmode=require" \
  -c "select version();"
```

Connection string for `DATABASE_URL`:
```
postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/my_money?sslmode=require
```

---

## Issue #23 — Backend on App Service

```bash
az appservice plan create -g $RG -n $PLAN --is-linux --sku B1

az webapp create -g $RG -p $PLAN -n $APP_NAME --runtime "NODE:20-lts"

# Run migrations on every start, listen on Azure's PORT
az webapp config set -g $RG -n $APP_NAME \
  --startup-file "npm run start:prod"

# App settings (env vars). Build is needed because we install with --omit=dev.
az webapp config appsettings set -g $RG -n $APP_NAME --settings \
  NODE_ENV=production \
  WEBSITE_NODE_DEFAULT_VERSION=~20 \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  DATABASE_URL="postgresql://${PG_ADMIN}:${PG_PASSWORD}@${PG_SERVER}.postgres.database.azure.com:5432/${DB_NAME}?sslmode=require" \
  JWT_SECRET="$(openssl rand -hex 48)" \
  CMC_PRO_API_KEY="<your-key>" \
  CG_API_KEY="<your-key>" \
  TZ="America/Mexico_City" \
  CORS_ORIGIN="https://<your-static-web-apps-host>"   # fill in after Issue #24

# Health check probe
az webapp config set -g $RG -n $APP_NAME --generic-configurations '{"healthCheckPath":"/health"}'

# HTTPS only
az webapp update -g $RG -n $APP_NAME --https-only true

# Get publish profile for the GitHub Action (Issue #23 deploy)
az webapp deployment list-publishing-profiles -g $RG -n $APP_NAME --xml > publish-profile.xml
```

GitHub setup for `deploy-backend.yml`:
- Repository **Variables**: `AZURE_BACKEND_APP_NAME` = `<APP_NAME>`
- Repository **Secrets**: `AZURE_BACKEND_PUBLISH_PROFILE` = contents of `publish-profile.xml`
- Then: push to `main` (or run the workflow manually).

Verify:
```bash
curl https://$APP_NAME.azurewebsites.net/health
curl https://$APP_NAME.azurewebsites.net/ready
az webapp log tail -g $RG -n $APP_NAME
```

---

## Issue #24 — Frontend on Static Web Apps

```bash
az staticwebapp create -g $RG -n $SWA_NAME -l eastus2 --sku Free \
  --source https://github.com/ZacheryGlass/my-money-tracker \
  --branch main \
  --app-location "frontend" \
  --output-location "dist" \
  --login-with-github
```

This auto-creates a workflow file in `.github/workflows/`. **Delete the auto-generated one** and keep our `deploy-frontend.yml` — then copy the `azure_static_web_apps_api_token` it set into the repo settings as that exact secret name.

GitHub setup:
- Repository **Variables**: `VITE_API_URL` = `https://<APP_NAME>.azurewebsites.net`
- Repository **Secrets**: `AZURE_STATIC_WEB_APPS_API_TOKEN` (from `az staticwebapp secrets list -n $SWA_NAME -g $RG`)

After first deploy, get the SWA hostname:
```bash
az staticwebapp show -n $SWA_NAME -g $RG --query "defaultHostname" -o tsv
```

Then update the backend's `CORS_ORIGIN` to that hostname:
```bash
az webapp config appsettings set -g $RG -n $APP_NAME --settings \
  CORS_ORIGIN="https://<swa-host>"
```

---

## Issue #25 — Custom domain & SSL

```bash
# Static Web Apps (frontend)
az staticwebapp hostname set -n $SWA_NAME -g $RG --hostname app.example.com
# Add the CNAME record SWA shows you in your DNS provider, then re-run to validate.

# App Service (backend) — managed cert is free for non-naked domains
az webapp config hostname add -g $RG --webapp-name $APP_NAME --hostname api.example.com
az webapp config ssl create -g $RG --name $APP_NAME --hostname api.example.com
THUMB=$(az webapp config ssl list -g $RG --query "[?subjectName=='api.example.com'].thumbprint" -o tsv)
az webapp config ssl bind -g $RG --name $APP_NAME --certificate-thumbprint $THUMB --ssl-type SNI
```

After custom domains are live, update:
- Backend `CORS_ORIGIN` → `https://app.example.com`
- Repo variable `VITE_API_URL` → `https://api.example.com` (re-run frontend workflow)

HSTS on the backend is already sent by Static Web Apps for the frontend (via `staticwebapp.config.json`); App Service enforces HTTPS via the `--https-only` flag set in #23.

---

## Rollback / kill switch

```bash
# Stop backend
az webapp stop -g $RG -n $APP_NAME

# Roll back to previous deployment
az webapp deployment list -g $RG -n $APP_NAME -o table
az webapp deployment source config-zip -g $RG -n $APP_NAME --src <previous.zip>
```

## Cost ballpark

- PostgreSQL B1ms + 32GB: ~$15/mo
- App Service B1 Linux: ~$13/mo
- Static Web Apps Free tier: $0
- **~$28/mo** (excluding outbound bandwidth)
