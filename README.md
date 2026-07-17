# OpenStack Monitor — Stream Deck Plugin

Monitor and control OpenStack instances right from your Stream Deck: **runtime status**, **resource usage**, and **power control**.
Built for OpenStack deployments that only allow Google SSO login, it uses an **Application Credential** to bypass SSO and call the API directly.

## Features

| Action | Display | Short press | Long press (0.8s) |
|--------|---------|-------------|-------------------|
| **Instance Status** | Running / Shut off / Error… (color-coded by status) | Refresh | Open the Horizon detail page |
| **Instance Usage** | CPU% / Memory% / Memory usage / vCPU / Disk | Refresh | Open the Horizon detail page |
| **Instance Power** | Power state (green / gray / orange) | Power on / off / reboot (configurable) | Open the Horizon detail page |

Connection credentials are stored in the Stream Deck **global settings** and shared across all three button types. When monitoring multiple machines, each button only needs its own Instance ID — the credentials are entered once.

## Prerequisites

1. **The `application_credential` authentication method must be enabled in your OpenStack Keystone**
   (see [`docs/enable-application-credential.md`](docs/enable-application-credential.md)).
2. Create a credential in Horizon → Identity → Application Credentials, and note its `id` and `secret`.

> ⚠️ **Common pitfall**: the `clouds.yaml` downloaded from Horizon escapes any `&` in the secret as `&amp;`.
> Restore it back to `&` before use (for example, `4Y5*gD6&amp;vCK!` is actually `4Y5*gD6&vCK!`).

## Configuration

In the Property Inspector of any button, fill in the following (connection settings are shared across all three buttons):

- **Keystone URL**: e.g. `http://<keystone-host>:5000/v3`
- **Credential ID** / **Credential Secret**
- **Region**: e.g. `RegionOne` (may be left empty)
- **Instance ID**: the UUID of the target server
- **Dashboard URL**: used to open the detail page on long press, e.g. `https://<horizon-host>/dashboard` (leave empty to disable open-on-long-press)

> If the API endpoint is on an internal network (e.g. `192.168.x.x`), the computer running Stream Deck must be on the same network (or connected via VPN).

## Development

```bash
yarn install
yarn verify      # Verify connectivity to OpenStack using the OS_* environment variables (see scripts/verify-openstack.mjs)
yarn icons       # Generate button icons
yarn watch       # Watch source changes, then automatically rebuild and restart the plugin
yarn build       # Package into a .streamDeckPlugin (output to releases/)
yarn lint        # Biome check
```

### Connection Verification

```bash
OS_AUTH_URL='http://<keystone-host>:5000/v3' \
OS_APPLICATION_CREDENTIAL_ID='<id>' \
OS_APPLICATION_CREDENTIAL_SECRET='<secret>' \
OS_REGION_NAME='RegionOne' \
OS_SERVER_ID='<instance-uuid>' \
yarn verify
```

This runs the following checks in order: exchange for a token (bypassing SSO) → locate the Nova endpoint → query the instance status → check Gnocchi metrics.

## Architecture

```
src/
├── plugin.ts          # Register actions, listen for global settings changes
├── settings.ts        # Settings types and utilities (connection = global, target = per-action)
├── openstack.ts       # Keystone authentication (token caching) + Nova + Gnocchi clients
├── metrics.ts         # Display item catalog and calculations (CPU%, memory%, etc.)
├── rendering.ts       # Canvas rendering of button images
└── actions/instance.ts# The three actions + shared polling / long-press framework
```

- **Authentication**: Application Credential → Keystone token (cached, automatically refreshed before expiry).
- **Metrics**: sourced from Gnocchi. `cpu` is cumulative ns; utilization = `rate:mean` ÷ (granularity × vcpus × 1e9) × 100.
```
