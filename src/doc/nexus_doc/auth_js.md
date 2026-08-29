# `auth.js` — Authentication and Authorization Module

## 1. Overview

The `auth.js` module provides authentication functionality for the application.

It supports two authentication mechanisms:

1. **API Key Authentication**
2. **HMAC-SHA256 Signed Token Authentication**

The module also provides functionality for:

- Secure comparison of API keys and signatures
- Generating signed authentication tokens
- Verifying signed tokens
- Token expiration checking
- Route-level authentication overrides
- Global authentication configuration
- Authentication failure logging
- Issuing new authentication tokens

The main entry point for application-level authentication is:

```js
createAuthenticator()
```

---

# 2. Imported Module

```js
import crypto from 'node:crypto';
```

The built-in Node.js `crypto` module provides cryptographic functionality used by this file.

It is used for:

- Constant-time comparisons through `crypto.timingSafeEqual()`
- Creating HMAC signatures through `crypto.createHmac()`
- SHA-256 hashing for token signatures

---

# 3. `safeEqual()`

```js
function safeEqual(a, b) {
```

## Purpose

`safeEqual()` compares two values in a way that is safer against **timing attacks**.

Instead of using:

```js
a === b
```

the function uses:

```js
crypto.timingSafeEqual()
```

for values of equal length.

---

## Converting Values to Buffers

```js
const bufA = Buffer.from(String(a));
const bufB = Buffer.from(String(b));
```

The two values are converted to strings and then into Node.js `Buffer` objects.

This is required because `crypto.timingSafeEqual()` operates on byte sequences.

---

## Length Check

```js
if (bufA.length !== bufB.length) {
  return false;
}
```

`crypto.timingSafeEqual()` requires both buffers to have the same length.

Therefore, the function first checks their lengths.

If they differ, the values cannot be equal and the function immediately returns `false`.

---

## Timing-Safe Comparison

```js
return crypto.timingSafeEqual(bufA, bufB);
```

When the buffers have equal lengths, `timingSafeEqual()` performs the comparison.

This is especially useful for comparing:

- API keys
- Cryptographic signatures
- Authentication tokens

---

# 4. `isValidApiKey()`

```js
export function isValidApiKey(headerValue, validKeys) {
```

## Purpose

Checks whether a supplied authentication header matches any configured API key.

---

## Missing Header Handling

```js
if (!headerValue) return false;
```

If no authentication value is provided, authentication fails immediately.

---

## Comparing Against All Valid Keys

```js
return validKeys.some((key) => safeEqual(headerValue, key));
```

The `.some()` method checks every configured API key.

For each key, `safeEqual()` is used instead of a normal string comparison.

The function returns:

```text
true
```

when at least one configured key matches.

Otherwise:

```text
false
```

---

# 5. `base64UrlEncode()`

```js
function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}
```

## Purpose

Converts input data into **Base64URL encoding**.

Base64URL is suitable for putting encoded data inside a token because it avoids characters that can be problematic in URLs and HTTP contexts.

This function is used when generating authentication tokens.

---

# 6. `base64UrlDecode()`

```js
function base64UrlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}
```

## Purpose

Performs the reverse operation of `base64UrlEncode()`.

It converts Base64URL-encoded data back into a UTF-8 string.

This is used during token verification to recover the original JSON payload.

---

# 7. `sign()`

```js
function sign(payloadB64, hmacSecret) {
  return crypto
    .createHmac('sha256', hmacSecret)
    .update(payloadB64)
    .digest('hex');
}
```

## Purpose

Creates a cryptographic signature for a token payload.

The function uses:

```text
HMAC-SHA256
```

with the configured secret.

---

## HMAC Creation

```js
crypto.createHmac('sha256', hmacSecret)
```

The HMAC algorithm uses:

- Hash function: SHA-256
- Secret key: `hmacSecret`

The secret must be known by the application in order to generate or verify valid signatures.

---

## Signing the Payload

```js
.update(payloadB64)
```

The Base64URL-encoded payload is used as the data being signed.

---

## Hexadecimal Signature

```js
.digest('hex')
```

The resulting cryptographic digest is converted into a hexadecimal string.

---

# 8. `generateToken()`

```js
export function generateToken(claims, hmacSecret, tokenExpirySeconds) {
```

## Purpose

Generates a signed authentication token containing custom claims and an expiration timestamp.

---

# 9. Creating the Token Payload

```js
const payload = {
  ...claims,
  exp: Date.now() + tokenExpirySeconds * 1000
};
```

The supplied claims are copied into a new payload.

An `exp` property is then added.

### `exp`

`exp` represents the expiration time of the token in milliseconds since the Unix epoch.

The calculation:

```js
tokenExpirySeconds * 1000
```

converts seconds into milliseconds.

For example:

```text
tokenExpirySeconds = 3600
```

means:

```text
3600 seconds
= 60 minutes
= 1 hour
```

---

## Claim Preservation

The spread operator:

```js
...claims
```

allows callers to add custom information.

For example:

```js
{
  userId: '123',
  role: 'admin'
}
```

could become:

```js
{
  userId: '123',
  role: 'admin',
  exp: 1234567890000
}
```

---

# 10. Encoding the Payload

```js
const payloadB64 = base64UrlEncode(JSON.stringify(payload));
```

The payload is first converted into JSON:

```text
JavaScript object
       ↓
JSON string
```

Then it is Base64URL encoded:

```text
JSON string
       ↓
Base64URL
```

The encoded value becomes the first part of the token.

---

# 11. Creating the Signature

```js
const signature = sign(payloadB64, hmacSecret);
```

The encoded payload is signed using the configured HMAC secret.

The signature protects the payload against unauthorized modification.

---

# 12. Final Token Structure

```js
return `${payloadB64}.${signature}`;
```

The final token has two components:

```text
PAYLOAD.SIGNATURE
```

For example:

```text
eyJ1c2VySWQiOiIxMjMifQ.a1b2c3d4...
```

The payload is not encrypted.

It is merely encoded.

The signature provides integrity/authenticity.

---

# 13. `verifyToken()`

```js
export function verifyToken(token, hmacSecret) {
```

## Purpose

Validates a generated authentication token.

The verification process checks:

1. Token structure
2. Signature
3. Payload format
4. Expiration time

Only when all required checks pass does the function consider the token valid.

---

# 14. Initial Token Validation

```js
if (!token || typeof token !== 'string' || !token.includes('.')) {
  return { valid: false, reason: 'invalid' };
}
```

The function first ensures that:

- A token exists
- The token is a string
- The token contains the expected separator `.`

If these conditions are not met, the token is considered invalid.

---

# 15. Splitting the Token

```js
const [payloadB64, signature] = token.split('.');
```

The token is divided into:

```text
payloadB64
signature
```

Expected structure:

```text
payload.signature
```

---

## Validating Both Components

```js
if (!payloadB64 || !signature) {
  return { valid: false, reason: 'invalid' };
}
```

Both parts must exist.

A token such as:

```text
payload.
```

or:

```text
.signature
```

is rejected.

---

# 16. Recalculating the Expected Signature

```js
const expectedSignature = sign(payloadB64, hmacSecret);
```

The server independently calculates what the signature should be.

It uses:

- The received payload
- The configured HMAC secret

---

# 17. Comparing Signatures

```js
if (!safeEqual(signature, expectedSignature)) {
  return { valid: false, reason: 'invalid' };
}
```

The received signature is compared with the newly generated signature using `safeEqual()`.

This is important because a token could have been modified.

For example, if someone changes:

```text
role=user
```

to:

```text
role=admin
```

the payload changes, meaning the expected signature also changes.

The old signature will no longer match.

Therefore, the modified token is rejected.

---

# 18. Decoding the Payload

```js
let payload;
try {
  payload = JSON.parse(base64UrlDecode(payloadB64));
} catch {
  return { valid: false, reason: 'invalid' };
}
```

After signature verification succeeds, the payload is decoded and parsed.

The process is:

```text
Base64URL
   ↓
UTF-8 string
   ↓
JSON.parse()
   ↓
JavaScript object
```

If decoding or JSON parsing fails, the token is considered invalid.

---

# 19. Expiration Validation

```js
if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
  return { valid: false, reason: 'expired', payload };
}
```

The token must contain a numeric `exp` property.

The current timestamp is compared against the expiration timestamp.

If:

```text
current time > expiration time
```

the token is considered expired.

---

## Important Detail

An expired token returns:

```js
{
  valid: false,
  reason: 'expired',
  payload
}
```

The decoded payload is included in the result.

This can be useful to the caller for diagnostics or handling expiration-related behavior.

---

# 20. Successful Token Verification

```js
return { valid: true, reason: 'token', payload };
```

If:

- Token structure is valid
- Signature is correct
- Payload can be decoded
- Token has not expired

the function returns:

```js
{
  valid: true,
  reason: 'token',
  payload
}
```

---

# 21. `createAuthenticator()`

```js
export function createAuthenticator(authConfig, logger) {
```

## Purpose

Creates the application's authentication manager.

This function combines API-key authentication and HMAC-token authentication into a single interface.

---

# 22. Authentication Configuration

```js
const headerName =
  (authConfig.headerName || 'X-API-Key').toLowerCase();

const validKeys = authConfig.keys || [];

const requiredByDefault =
  authConfig.requiredByDefault === true;

const hmacSecret =
  authConfig.hmacSecret || null;

const tokenExpirySeconds =
  authConfig.tokenExpirySeconds || 3600;
```

These values determine how authentication behaves.

---

## `headerName`

Specifies the HTTP header from which the authentication credential is read.

Default:

```text
X-API-Key
```

The name is converted to lowercase because Node.js HTTP header names are normalized to lowercase.

Therefore:

```text
X-API-Key
```

becomes:

```text
x-api-key
```

---

## `validKeys`

Contains the configured API keys.

If no keys are configured:

```js
[]
```

is used.

---

## `requiredByDefault`

Controls whether authentication is required by default.

Only an explicit:

```js
requiredByDefault: true
```

enables authentication by default.

---

## `hmacSecret`

The secret used for HMAC token generation and verification.

If no secret is configured:

```js
null
```

is used.

This means token-based authentication and token issuance are unavailable.

---

## `tokenExpirySeconds`

Controls the lifetime of generated tokens.

The default is:

```text
3600 seconds
```

which equals:

```text
1 hour
```

---

# 23. `isRequired()`

```js
function isRequired(routeAuthOverride) {
```

## Purpose

Determines whether authentication is required for a particular route.

It supports both:

- Global authentication configuration
- Route-specific authentication overrides

---

# 24. No Route Override

```js
if (routeAuthOverride == null) return requiredByDefault;
```

If the route does not provide an authentication override, the global setting is used.

For example:

```text
requiredByDefault = true
```

means authentication is required unless the route explicitly overrides it.

---

# 25. Boolean Route Override

```js
if (typeof routeAuthOverride === 'boolean') {
  return routeAuthOverride;
}
```

A route can directly specify:

```js
true
```

or:

```js
false
```

For example:

```text
routeAuthOverride = false
```

means authentication is not required for that route.

---

# 26. Object Route Override

```js
if (typeof routeAuthOverride.required === 'boolean') {
  return routeAuthOverride.required;
}
```

The override can also be an object such as:

```js
{
  required: true
}
```

or:

```js
{
  required: false
}
```

The `required` property determines the route's authentication requirement.

---

# 27. Fallback Behavior

```js
return requiredByDefault;
```

If the override does not match any supported format, the global default is used.

This prevents unexpected configuration values from accidentally disabling authentication.

---

# 28. `logFailure()`

```js
function logFailure(reason, routeLabel) {
```

## Purpose

Logs an authentication failure.

---

## Log Message

```js
log.info(
  `auth failed (${reason})${
    routeLabel ? ` for route ${routeLabel}` : ''
  }`
);
```

The reason is included in the log.

Possible reasons include:

- `missing`
- `invalid`
- `expired`

If a route label is provided, it is also included.

Example:

```text
auth failed (missing) for route /admin
```

---

# 29. `authenticate()`

```js
function authenticate(headers, routeAuthOverride, routeLabel) {
```

## Purpose

This is the main authentication function exposed by the module.

It determines whether a request is authenticated using the configured authentication mechanisms.

---

# 30. Checking Whether Authentication Is Required

```js
if (!isRequired(routeAuthOverride)) {
  return {
    authenticated: true,
    reason: 'not_required'
  };
}
```

If authentication is not required for the route, the request is immediately accepted.

The returned result is:

```js
{
  authenticated: true,
  reason: 'not_required'
}
```

This does not mean credentials were verified. It means authentication was not required.

---

# 31. Reading the Authentication Header

```js
const headerValue = headers
  ? headers[headerName]
  : undefined;
```

The configured authentication header is retrieved from the request headers.

For example, if:

```text
headerName = x-api-key
```

the function looks for:

```js
headers['x-api-key']
```

---

# 32. Missing Credential

```js
if (!headerValue) {
  logFailure('missing', routeLabel);
  return {
    authenticated: false,
    reason: 'missing'
  };
}
```

If no authentication credential was provided:

- The failure is logged.
- Authentication fails.
- The reason is `missing`.

---

# 33. API Key Authentication

```js
if (isValidApiKey(headerValue, validKeys)) {
  return {
    authenticated: true,
    reason: 'api_key'
  };
}
```

The supplied header is first tested against the configured API keys.

If a valid API key is found:

```js
{
  authenticated: true,
  reason: 'api_key'
}
```

is returned.

The token verification process is not required when the API key is already valid.

---

# 34. HMAC Token Authentication

```js
if (hmacSecret) {
  const result = verifyToken(headerValue, hmacSecret);
```

If API-key authentication fails and an HMAC secret is configured, the same header value is treated as a possible signed token.

The token is passed to:

```js
verifyToken()
```

---

# 35. Valid Token

```js
if (result.valid) {
  return {
    authenticated: true,
    reason: 'token'
  };
}
```

If token verification succeeds, authentication succeeds.

The returned reason identifies the authentication method:

```text
token
```

---

# 36. Invalid or Expired Token

```js
logFailure(result.reason, routeLabel);

return {
  authenticated: false,
  reason: result.reason
};
```

If the token is invalid or expired:

1. The failure is logged.
2. Authentication fails.
3. The reason returned by `verifyToken()` is preserved.

For example:

```js
{
  authenticated: false,
  reason: 'expired'
}
```

---

# 37. No HMAC Secret Available

```js
logFailure('invalid', routeLabel);

return {
  authenticated: false,
  reason: 'invalid'
};
```

If:

- API key authentication fails
- No HMAC secret is configured

then there is no token authentication mechanism available.

The credential is therefore rejected as invalid.

---

# 38. `issueToken()`

```js
function issueToken(claims) {
```

## Purpose

Creates a new signed authentication token using the configured HMAC secret.

---

# 39. Checking HMAC Configuration

```js
if (!hmacSecret) {
  throw new Error(
    'cannot issue token: auth.hmacSecret is not configured'
  );
}
```

Token generation requires an HMAC secret.

If no secret exists, token issuance is impossible and the function throws an error.

This prevents the application from generating unsigned or insecure tokens.

---

# 40. Generating the Token

```js
return generateToken(
  claims,
  hmacSecret,
  tokenExpirySeconds
);
```

The function delegates token creation to `generateToken()`.

It supplies:

- Caller-provided claims
- Configured HMAC secret
- Configured token expiration time

---

# 41. Public API

The authenticator exposes only:

```js
return {
  authenticate,
  issueToken
};
```

Therefore, callers interact with the module through:

| Function | Purpose |
|---|---|
| `authenticate()` | Authenticate an incoming request |
| `issueToken()` | Generate a new signed token |

The lower-level cryptographic helper functions remain internal except for the explicitly exported:

- `isValidApiKey()`
- `generateToken()`
- `verifyToken()`

---

# 42. Authentication Decision Flow

The main authentication process can be visualized as:

```text
                Incoming Request
                       │
                       ▼
              Is auth required?
                 /           \
               No             Yes
               │               │
               ▼               ▼
           Allow        Authentication header?
                               │
                         ┌─────┴─────┐
                        No           Yes
                        │             │
                        ▼             ▼
                      Reject      Valid API key?
                                    │
                              ┌─────┴─────┐
                             Yes           No
                             │             │
                             ▼             ▼
                           Allow      HMAC secret?
                                          │
                                    ┌─────┴─────┐
                                   No           Yes
                                   │             │
                                   ▼             ▼
                                 Reject      Valid token?
                                                │
                                          ┌─────┴─────┐
                                         Yes           No
                                         │             │
                                         ▼             ▼
                                       Allow         Reject
```

---

# 43. Authentication Methods

This module effectively supports two credential types through the same configured HTTP header.

## API Key

```text
Request Header
      │
      ▼
Compare with configured keys
      │
      ▼
Constant-time comparison
      │
      ▼
Authenticated / Rejected
```

## HMAC Token

```text
Request Header
      │
      ▼
Split payload + signature
      │
      ▼
Recalculate HMAC-SHA256
      │
      ▼
Compare signatures
      │
      ▼
Decode payload
      │
      ▼
Check expiration
      │
      ▼
Authenticated / Rejected
```

---

# 44. Token Structure

The generated token has the following structure:

```text
Base64URL(JSON Payload).HMAC-SHA256 Signature
```

For example:

```text
eyJ1c2VySWQiOiIxMjMifQ.abcdef123456...
```

The first section contains encoded claims.

The second section proves that the payload was signed using the expected secret.

---

# 45. Token Security Model

The token is **signed, not encrypted**.

This means the payload can technically be decoded by someone who possesses the token.

For example, claims such as:

```js
{
  userId: '123',
  role: 'admin'
}
```

should not be treated as secret merely because they are inside the token.

The security property provided by HMAC is **integrity and authenticity**:

```text
Can the payload be trusted as unmodified?
```

The answer is yes only when its signature validates with the server's secret.

---

# 46. Token Expiration Flow

When a token is generated:

```text
Current Time
     +
Expiry Duration
     ↓
exp timestamp
```

During verification:

```text
Current Time > exp ?
       │
   ┌───┴───┐
  Yes      No
   │        │
   ▼        ▼
Expired   Valid
```

This prevents tokens from remaining valid indefinitely.

---

# 47. Route-Level Authentication

The module supports both global and route-specific authentication policies.

For example, the application can have:

```text
Global:
Authentication required
```

while allowing a public route to override it:

```text
/health → authentication not required
```

This makes the authentication layer flexible enough for applications containing both public and protected endpoints.

---

# 48. Example Configuration

A possible configuration could look like:

```js
{
  headerName: 'X-API-Key',
  keys: [
    'key-one',
    'key-two'
  ],
  requiredByDefault: true,
  hmacSecret: 'server-secret',
  tokenExpirySeconds: 3600
}
```

This configuration means:

- Authentication is required by default.
- `X-API-Key` is used as the credential header.
- Two API keys are accepted.
- HMAC token authentication is enabled.
- Generated tokens expire after one hour.

---

# 49. Example Authentication Results

### Authentication Not Required

```js
{
  authenticated: true,
  reason: 'not_required'
}
```

### Valid API Key

```js
{
  authenticated: true,
  reason: 'api_key'
}
```

### Valid Token

```js
{
  authenticated: true,
  reason: 'token'
}
```

### Missing Credential

```js
{
  authenticated: false,
  reason: 'missing'
}
```

### Invalid Credential

```js
{
  authenticated: false,
  reason: 'invalid'
}
```

### Expired Token

```js
{
  authenticated: false,
  reason: 'expired'
}
```

---

# 50. Important Design Characteristics

## 50.1 Constant-Time Credential Comparison

`safeEqual()` uses `crypto.timingSafeEqual()` for API keys and signatures.

## 50.2 Multiple Authentication Mechanisms

The same authentication system can accept either:

- Configured API keys
- HMAC-signed tokens

## 50.3 Token Integrity

HMAC-SHA256 prevents unauthorized modification of token payloads without knowledge of the secret.

## 50.4 Token Expiration

Tokens automatically become invalid after their configured expiration time.

## 50.5 Configurable Authentication Requirement

Authentication can be globally required or selectively overridden on individual routes.

## 50.6 Graceful Authentication Failures

Authentication functions return structured results rather than throwing errors for normal authentication failures.

## 50.7 Logging

Authentication failures can be logged with their reason and optional route label.

---

# 51. Overall Module Architecture

```text
                         auth.js
                            │
            ┌───────────────┴────────────────┐
            │                                │
            ▼                                ▼
       API Key System                    Token System
            │                                │
            ▼                                ▼
    isValidApiKey()                   generateToken()
            │                                │
            ▼                                ▼
       safeEqual()                         sign()
                                             │
                                             ▼
                                      HMAC-SHA256
                                             │
                                             ▼
                                        Token
                                             │
                                             ▼
                                      verifyToken()
                                             │
                          ┌──────────────────┼─────────────────┐
                          │                  │                 │
                          ▼                  ▼                 ▼
                      Structure          Signature         Expiration
                          │                  │                 │
                          └──────────────────┼─────────────────┘
                                             ▼
                                         Valid/Invalid
```

The higher-level interface is:

```text
createAuthenticator()
        │
        ├── authenticate()
        │
        └── issueToken()
```

---

# 52. Summary

`auth.js` is the application's central authentication module.

Its main responsibilities are:

1. Validate API keys.
2. Compare sensitive credentials using timing-safe comparison.
3. Generate HMAC-SHA256 signed authentication tokens.
4. Encode token payloads using Base64URL.
5. Verify token signatures.
6. Decode and validate token payloads.
7. Enforce token expiration.
8. Support route-level authentication overrides.
9. Authenticate requests using either API keys or signed tokens.
10. Generate new tokens when HMAC authentication is configured.
11. Log authentication failures.
12. Return structured authentication results.

The overall authentication strategy is:

```text
                Credential
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       API Key             HMAC Token
          │                   │
          ▼                   ▼
   timing-safe match     Verify signature
          │                   │
          │                   ▼
          │              Check expiration
          │                   │
          └─────────┬─────────┘
                    ▼
             Authentication
                    │
              ┌─────┴─────┐
             Valid       Invalid
               │            │
               ▼            ▼
             Allow        Reject
```

In short, **`auth.js` provides the application's authentication layer, combining API-key validation and cryptographically signed, expiring tokens while keeping authentication behavior configurable at both global and route levels.**