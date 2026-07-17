# Request: Please Enable the Application Credential Authentication Method in Keystone

## Problem

I want to monitor instances via the OpenStack API. Because the dashboard only allows Google SSO login, the standard approach is to create an **Application Credential** to bypass SSO and call the API.

I have successfully created an application credential in Horizon, but when I use it to exchange for a token with Keystone, the request is rejected:

```
POST http://<keystone-host>:5000/v3/auth/tokens
→ HTTP 401
{"error":{"message":"Attempted to authenticate with an unsupported method.",
  "identity":{"methods":["password","token","saml2","openid"]}}}
```

This means the `[auth] methods` on this Keystone (v3.12) does not include `application_credential`, so the authentication pipeline does not accept application credentials.

## Required Change

In the `[auth]` section of **keystone.conf**, **append** `application_credential` to `methods`
(keep the existing methods — only add, never remove, otherwise Google SSO will break):

```ini
[auth]
# Original: methods = password,token,saml2,openid
methods = password,token,saml2,openid,application_credential
```

`application_credential` is a built-in Keystone authentication plugin. No additional package is required — simply adding the name is enough.

## Restart Keystone After the Change (choose the one matching your deployment)

```bash
# Package install (Keystone running under Apache mod_wsgi)
sudo systemctl restart apache2      # Debian/Ubuntu
sudo systemctl restart httpd        # RHEL/CentOS

# DevStack
sudo systemctl restart devstack@keystone

# Kolla-Ansible (container deployment)
#   keystone.conf is at /etc/kolla/keystone/keystone.conf
sudo docker restart keystone
```

## Scope of Impact and Security

- **This only adds one authentication method**, and does not affect existing password / SSO (saml2 / openid) logins.
- Application credentials are created by the user, can have an expiration time set, can be restricted to specific roles, and can be revoked at any time. They are more secure than sharing account credentials directly, and are exactly the mechanism OpenStack designed for programmatic API access in federated/SSO environments.

## Verification (I will handle this)

Once the administrator has made the change and restarted, I only need to exchange for a token again with my existing application credential — there is no need to recreate the credential. If it still fails, I will report back.
