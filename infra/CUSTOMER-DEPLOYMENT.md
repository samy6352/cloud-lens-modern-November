# CloudLens customer deployment

Use the reviewed **installer-source ZIP**, extracted in full. An App Service
runtime ZIP is not an installer. Keep the extracted folder and generated
`data\deployments` state for upgrades and recovery. No customer subscription,
tenant, password or token is supplied by this runbook.

This is a deployment candidate, not certification for a customer's environment.
Customer policy, quota, billing, networking and identity checks must pass before
production acceptance. Do not copy the development deployment's IDs or identities.

## 1. Agree responsibilities and scope

| Responsibility | Required access |
|---|---|
| Hosting deployment | Resource creation and provider registration in the hosting subscription, plus role-assignment authority for bootstrap grants. Typically Owner, or Contributor plus User Access Administrator, subject to conditions. |
| Microsoft sign-in registration | Customer identity team approves or supplies the Entra registration. Subscription Owner is not an Entra administrator. |
| Monitored subscription onboarding | A subscription RBAC administrator grants the runtime identity Reader and Cost Management Reader. Readers using the app do not perform these grants. |
| Central onboarding alternative | An authorised administrator grants those roles on an approved management group. Only descendant subscriptions inherit them; confirm scope and blast radius first. |
| Optional managed exports | Separately approved Cost Management Contributor for the runtime, and operator-led export/storage identity provisioning. Read roles alone do not enable export creation or execution. |
| Everyday use | Users retain their own cost-capable Azure access; app-identity mode also limits them to subscriptions readable by the runtime identity. |

Never grant subscription Owner, User Access Administrator or RBAC Administrator
to the runtime identity. Do not reuse another application's system-assigned
identity. Human roles and runtime roles are separate grants.

Approve hosting and AI regions, AI model/SKU processing residency, sizing and
ongoing charges. The current defaults include `gpt-4.1-mini` / `GlobalStandard`;
the AI resource's region does not guarantee processing stays in that region.
Review the network ranges and private endpoints in `main.bicep` and its modules
against the customer's network policy before proceeding.

## 2. Verify and preview

### One-line download and installation

Install PowerShell 7, Azure CLI and Python 3.11+ first. Sign in with `az login`
to the approved customer tenant. The source ZIP contains the built interface;
Node.js 20+ is needed only to rebuild it.

An authorised maintainer's version-tag push invokes the gated release workflow.
Only after its required checks succeed and the matching GitHub Release contains
`CloudLens-2026.11.12-rc5-source.zip` and `SHA256SUMS.txt` can customers run
this example for tag `v2026.11.12-rc5` in PowerShell 7:

```powershell
irm 'https://raw.githubusercontent.com/samy6352/cloud-lens-modern-November/v2026.11.12-rc5/tools/install-customer.ps1' | iex
```

This command is not available until that release and tag are published. A private
repository also needs authenticated access; browser sign-in alone does not
authenticate `Invoke-WebRequest`. Do not embed a token in the one-liner. In that
case, obtain the source ZIP through the customer's approved authenticated download
process and use the extracted installer instead.

Maintainers must update the bootstrap's default `Version` and these versioned
examples before creating a new release tag; the release workflow rejects a tag
whose version differs from the tagged bootstrap default. The release assets are
the versioned source ZIP, runtime ZIP, `SHA256SUMS.txt` and a provenance JSON
record linking the release to its exact commit SHA. Do not replace assets of an
already published version; issue a new version instead. Local candidate ZIPs,
successful local checks and a tag alone are not evidence that release assets
have been published. The existing locally prepared rc1/rc2 ZIPs are stale
candidates, not approved artifacts for the corrected code.

The bootstrap downloads the versioned release ZIP and checksum, checks the hash and archive
paths, then extracts into a new folder under `$HOME\CloudLens`. It requires
approved regions, an explicit hosting subscription ID and a new dedicated
resource-group name. By default it now drives setup with numbered pick-lists
(subscription, region, scope, sizing and import window), with recommended
defaults selected on Enter. It selects and verifies that subscription, runs
preflight and ARM preview, then asks for a final proceed/cancel confirmation
before provisioning. The prior Azure CLI subscription selection is restored.
Existing resource groups are refused by default, even with a new extraction folder.
For preview or an intentional resume, invoke the bootstrap script block with
explicit parameters:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/samy6352/cloud-lens-modern-November/v2026.11.12-rc5/tools/install-customer.ps1'))) `
    -SubscriptionId '<hosting-subscription-id>' -ResourceGroup '<dedicated-resource-group>' -Preview
```

Replace `-Preview` with `-Resume` only when resuming this same dedicated
installation. Retain the downloaded source folder and storage-name state.
The checksum is hosted with the release, not an independent publisher signature;
trust the repository/release publisher before executing the bootstrap.
Keep the extracted folder for recovery. No Git clone or manual extraction is needed.

For a customer who wants to enter approved settings up front, the equivalent
three-line command is:

```powershell
az login --tenant '<customer-tenant-id>'
$install = irm 'https://raw.githubusercontent.com/samy6352/cloud-lens-modern-November/v2026.11.12-rc5/tools/install-customer.ps1'
& ([scriptblock]::Create($install)) -SubscriptionId '<hosting-subscription-id>' -ResourceGroup '<new-dedicated-resource-group>' -Location '<approved-app-region>' -AiLocation '<approved-ai-region>'
```

The final target-specific approval prompt is intentionally retained for interactive runs.
For non-interactive automation, pass `-Approve` explicitly. The initial
import defaults to one calendar month to reduce first-run time and load; use
`-InitialHistoryMonths 3` when a larger starting window has been approved.
`-Size small|medium|large` selects the same sizing in preflight and installation.
Optional `-NamePrefix` and `-NameSuffix` must be supplied together.

For private/offline distribution or an unpublished release rehearsal, use the same
bootstrap after obtaining the approved ZIP and SHA-256 through the authorised
download process:

```powershell
.\tools\install-customer.ps1 -SourceZip '<source-zip-path>' -SourceSha256 '<independently-supplied-sha256>'
```

This still validates and extracts the archive and performs the same Azure
preflight, preview, approval and installation. It is not proof that the GitHub
download link is published or reachable.

Compare the delivered ZIP's SHA-256 with the separately delivered checksum:

```powershell
Get-FileHash '<installer-source-zip>' -Algorithm SHA256
```

From the extracted folder, verify every payload file:

```powershell
python .\tools\verify_package.py '<installer-source-zip>' --kind installer-source
```

Replace every placeholder below with customer-approved values; do not run the
examples unchanged. Use a new dedicated resource group. Record the selected
subscription and tenant before provisioning.

```powershell
az login --tenant '<customer-tenant-id>'
az account set --subscription '<hosting-subscription-id>'
az account show --query '{subscription:id,name:name,tenant:tenantId}' -o json

$install = @{
    SubscriptionId = '<hosting-subscription-id>'
    Scope = 'all' # or '/providers/Microsoft.Management/managementGroups/<id>' / a specific subscription
    ResourceGroup = '<new-dedicated-resource-group>'
    Location = '<approved-app-and-database-region>'
    AiLocation = '<approved-ai-region>'
    EntraAppUniqueName = '<customer-approved-registration-name>'
    NamePrefix = '<approved-name-prefix>'
    NameSuffix = '<unique-suffix>'
    Size = 'medium'
    InitialHistoryMonths = 1
    NonInteractive = $true
    AppIdentityOnly = $true
}
# Add EntraClientId to $install if the identity team supplied an approved registration.
.\infra\install.ps1 @install -WhatIf
```

Preview is not installation. Resolve warnings, quota failures, naming collisions,
soft-deleted resource names and permission gaps before provisioning. Do not purge
or restore customer resources without explicit approval.

## 3. Install once in the hosting subscription

After customer approval, run the same options without `-WhatIf`:

```powershell
.\infra\install.ps1 @install
```

**Customer mode:** `-AppIdentityOnly` skips the delegated ARM admin-consent
attempt and sets `AUTH_DELEGATED_ARM=false` through the infrastructure template.
It also does not add delegated ARM permissions to an adopted registration.
Existing consent does not upgrade this deployment to delegated mode. Preserve this
option on every redeployment, and inspect `/api/auth/me` after sign-in.
This does not bypass customer approval for the sign-in registration or tenant
sign-in/consent policy. `-LocalSignIn` is a different authentication design, not
an automatic substitute. `-AllowAppIdentityFallback` alone is not equivalent:
it can still attempt consent and upgrade when consent succeeds.

The standard installer enables managed exports and requests Cost Management
Contributor on its initial monitored scope. It is not a read-only-only bootstrap.
Approve those hosting-scope permissions, or stop and use the detailed deployment
guide to design a separately reviewed minimal deployment.

Record the resulting app name, URL, runtime principal/object ID, hosting
subscription, resource group and export storage ID. Obtain these from this
customer's deployment, never from a development example.

## 4. Onboard additional subscriptions through the administrator

All target subscriptions must be in the app's tenant. The operator can generate
the exact customer-specific read-only commands without granting anything:

```powershell
.\infra\add-subscriptions.ps1 `
    -HostingSubscriptionId '<hosting-subscription-id>' `
    -ResourceGroup '<hosting-resource-group>' -AppName '<deployed-app-name>' `
    -SubscriptionId '<target-subscription-id>' `
    -ReadOnlyCostAccess -InstructionsOnly
```

Give the generated commands to that subscription's RBAC administrator. They grant
**Reader** and **Cost Management Reader** to the resolved runtime principal/object
ID, not to the client ID or the sign-in registration. Alternatively, a central
administrator can grant these roles on a verified management-group scope.

After the grants propagate, rerun with the same arguments but without
`-InstructionsOnly`, retaining `-ReadOnlyCostAccess`. Expect both roles to be
verified; do not report onboarding complete while either is pending. In the app,
use Setup's **Check now** to refresh discovery.

Read-only onboarding is not a promise that every billing view is populated.
EA/MCA billing policy can restrict cost visibility. Export-backed history,
granular billing and related views need a usable FOCUS export and storage access.
For managed exports, get separate approval, then use the customer-scoped
`focus-exports.ps1` workflow described in `README.md`. Always supply the exact
target subscription list; do not rely on all-visible defaults.

## 5. Acceptance and operational handoff

- Require `/healthz` and `/readyz` to return HTTP 200 on the printed HTTPS URL.
  Running App Service alone does not mean the database is ready.
- Require the running process's `/release.json` `releaseId` to match the runtime
  package manifest. Publication follows the upload's correlated SCM receipt and
  exact deployment ID; another successful build or an old healthy process is not acceptance.
- Sign in as a representative non-admin Reader user. Confirm the intended
  subscriptions appear and an unauthorised subscription is not accessible.
- Check `/api/auth/me` for the expected access mode and subscription ceiling.
- Verify Setup permission/export status, a live cost read and an imported report.
  Record incomplete coverage explicitly. New FOCUS exports may take up to 24 hours.
- Confirm HTTPS/sign-in enforcement, private connectivity, approved AI processing,
  database backups/restore policy, monitoring and an operational owner.
- Review customer automation that stops databases. A stopped PostgreSQL server
  makes the app unready; agree running hours and alerting before handoff.
- Retain release version/checksum, deployment outputs, approvals and recovery
  state securely. Do not distribute local `.env`, databases, tokens, cost reports,
  logs or deployment state in the release ZIP.

Do not delete the resource group to recover from a partial failure. Preserve the
error and state, fix the cause, and use the detailed deployment guide for recovery.
The deployment is accepted only after these checks pass in the customer tenant.

FOCUS provisioning returns structured per-subscription results. A partial failure
throws with those results attached as `Exception.Data['CloudLensExportResult']`;
completed exports remain intact. Fix access and rerun the same scoped command.
The installer must not report success until its required exports are complete.

Managed exports alone enable storage-scoped delegation. Its ABAC condition limits
both assignment creation and deletion to Storage Blob Data Contributor for service
principals, using Request attributes for writes and Resource attributes for deletes.
It does not grant subscription-wide role administration. An incremental deployment
that disables this feature does not remove a previously deployed delegation grant:
have the customer RBAC administrator review and remove that exact grant separately.

### Existing-stack delegation reconciliation

Conditional omission is not revocation. Record this as **pending IAM
reconciliation** until the customer RBAC administrator verifies the existing
assignments; neither a successful deployment nor `managedExports=false` proves
that a legacy storage delegation was removed.

Use the storage-account resource ID and runtime principal object ID recorded for
this customer installation, not development examples or the sign-in client ID.
The following inventory is read-only:

```powershell
$storageId = '<customer-export-storage-account-resource-id>'
$runtimePrincipalId = '<customer-runtime-principal-object-id>'
$assignments = @(az role assignment list --scope $storageId --include-inherited `
    --fill-principal-name false --only-show-errors -o json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not inventory grants. Reconciliation remains pending.' }
$candidates = @($assignments | Where-Object {
    $_.scope -ieq $storageId -and $_.principalId -ieq $runtimePrincipalId -and
    ([string]$_.roleDefinitionId).Split('/')[-1] -eq '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'
})
$candidates | Select-Object id, principalId, scope, roleDefinitionId, conditionVersion, condition |
    Format-List
```

Confirm the exact candidate assignment ID against this installation's original
`cloudlens-stack` deployment/history before changing it. The template's assignment
name is `guid(storage.id, identity.id, userAccessAdministrator)`; changing storage,
identity or naming parameters is not a permission migration. If there are multiple
candidates, missing ownership evidence or inherited role-administration grants,
stop for customer RBAC review rather than guessing or deleting all matches.

- If managed exports remain approved, preview and redeploy this installation
  with its original storage/identity/naming and managed-export settings. The
  same owned assignment should be updated in place. Verify `conditionVersion=2.0`
  and both the Request/write and Resource/delete restrictions on Blob Data
  Contributor and service-principal type after deployment.
- If runtime delegation is no longer needed, an authorised customer administrator
  can remove only the reviewed assignment after explicit approval:
  `az role assignment delete --ids '<reviewed-exact-role-assignment-resource-id>'`.
  This is an operator procedure, not an installer cleanup action.

Repeat the inventory after the approved change, retain the before/after assignment
evidence, and check inherited grants separately. Do not mark reconciliation complete
from a template flag alone. No role deletion is required merely to inspect the state.
