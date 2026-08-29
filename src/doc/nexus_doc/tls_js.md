# `tls.js` — TLS and HTTPS Security Module

## 1. Overview

The `tls.js` module provides the application's TLS/HTTPS infrastructure.

Its responsibilities include:

- Checking whether OpenSSL is available
- Providing a manual OpenSSL certificate-generation command
- Creating directories required for certificate files
- Generating self-signed TLS certificates
- Ensuring that certificates and private keys exist
- Loading certificate and private-key data
- Reading certificate expiration dates
- Warning when certificates are close to expiration
- Supporting SNI (Server Name Indication)
- Caching TLS secure contexts
- Creating an HTTPS server

The primary HTTPS server entry point is:

```js
createHttpsServer()
```

The module also exposes several utility functions that can be used independently.

---

# 2. Imported Modules

```js
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import childProcess from 'node:child_process';
```

The module uses several Node.js built-in modules.

| Module | Purpose |
|---|---|
| `fs` | File and directory operations |
| `path` | Cross-platform filesystem path manipulation |
| `tls` | TLS secure-context creation |
| `https` | HTTPS server creation |
| `childProcess` | Executing OpenSSL commands |

No external npm package is required for the TLS functionality.

---

# 3. TLS Concepts Used by This Module

Before understanding the implementation, it is useful to understand the main TLS components used here.

### Certificate

The certificate identifies the server and contains its public-key information.

### Private Key

The private key is used by the server as part of the TLS cryptographic handshake.

It must be protected because anyone possessing the private key can potentially impersonate the server.

### HTTPS

HTTPS is HTTP running over TLS.

The module creates an HTTPS server using:

```js
https.createServer()
```

### SNI

SNI stands for **Server Name Indication**.

It allows a single HTTPS server to select different TLS certificates depending on the hostname requested by the client.

For example:

```text
example.com     → certificate A
api.example.com → certificate B
```

---

# 4. `isOpensslAvailable()`

```js
export function isOpensslAvailable() {
```

## Purpose

Checks whether the `openssl` executable is available through the system's `PATH`.

This is required because the module uses OpenSSL to generate self-signed certificates and inspect certificate expiration dates.

---

## Executing OpenSSL

```js
childProcess.execFileSync(
  'openssl',
  ['version'],
  { stdio: 'ignore' }
);
```

The command executed is effectively:

```text
openssl version
```

If OpenSSL is installed and accessible through `PATH`, the command succeeds.

---

## Successful Result

```js
return true;
```

A successful OpenSSL invocation means OpenSSL is available.

---

## Failure Handling

```js
catch {
  return false;
}
```

If the command cannot be executed, the function returns `false`.

This can happen when:

- OpenSSL is not installed
- OpenSSL is not in `PATH`
- The operating environment prevents execution

The function intentionally hides the underlying error because its purpose is simply to answer:

```text
Is OpenSSL available?
```

---

# 5. `opensslManualCommand()`

```js
export function opensslManualCommand(certPath, keyPath) {
```

## Purpose

Builds an OpenSSL command that can be shown to the user when automatic certificate generation is unavailable.

---

## Generated Command

```js
return `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 365 -subj "/CN=localhost"`;
```

The resulting command uses:

```text
openssl req
```

to generate a self-signed certificate.

---

## Command Components

### `req`

Invokes OpenSSL's certificate request functionality.

### `-x509`

Creates a self-signed X.509 certificate.

### `-newkey rsa:2048`

Creates a new 2048-bit RSA private key.

### `-nodes`

Prevents the private key from being encrypted with a passphrase.

This allows the server to load the key automatically without requiring interactive password input.

### `-keyout`

Specifies where the private key should be written.

### `-out`

Specifies where the certificate should be written.

### `-days 365`

Makes the generated certificate valid for approximately one year.

### `-subj "/CN=localhost"`

Sets the certificate subject's Common Name to:

```text
localhost
```

This makes the generated certificate primarily suitable for local development/testing.

---

# 6. `ensureDirForFile()`

```js
function ensureDirForFile(filePath) {
```

## Purpose

Ensures that the directory containing a file exists.

---

## Directory Extraction

```js
path.dirname(filePath)
```

If the file path is:

```text
certs/server/cert.pem
```

then:

```text
path.dirname(...)
```

produces:

```text
certs/server
```

---

## Creating the Directory

```js
fs.mkdirSync(
  path.dirname(filePath),
  { recursive: true }
);
```

The `recursive: true` option creates all missing parent directories.

For example:

```text
certs/
└── server/
    └── cert.pem
```

can be created even if neither `certs/` nor `server/` exists.

---

# 7. `generateSelfSignedCert()`

```js
function generateSelfSignedCert(certPath, keyPath) {
```

## Purpose

Generates a self-signed TLS certificate and private key using OpenSSL.

This function is internal and is used by `ensureCertificate()`.

---

# 8. Checking for OpenSSL

```js
if (!isOpensslAvailable()) {
```

Before attempting certificate generation, the function verifies that OpenSSL is available.

---

## Error Message

```js
throw new Error(
  `openssl not found on PATH. Generate a certificate manually and re-run:\n${opensslManualCommand(certPath, keyPath)}`
);
```

If OpenSSL is unavailable, the function throws a helpful error.

The error contains a ready-to-run manual command.

This is useful because the application tells the developer exactly how to generate the required certificate.

---

# 9. Preparing Certificate Directories

```js
ensureDirForFile(certPath);
ensureDirForFile(keyPath);
```

The function ensures that the directories for both:

- Certificate
- Private key

exist before OpenSSL writes the files.

---

# 10. Constructing the OpenSSL Command

```js
const cmd = [
  'openssl req -x509 -newkey rsa:2048 -nodes',
  `-keyout "${keyPath}"`,
  `-out "${certPath}"`,
  '-days 365',
  '-subj "/CN=localhost"'
].join(' ');
```

The command is constructed from multiple pieces.

The resulting command is equivalent to:

```text
openssl req -x509 -newkey rsa:2048 -nodes \
-keyout "<keyPath>" \
-out "<certPath>" \
-days 365 \
-subj "/CN=localhost"
```

The paths are surrounded by quotes to better support paths containing spaces.

---

# 11. Executing OpenSSL

```js
childProcess.execSync(cmd, { stdio: 'ignore' });
```

The generated command is executed synchronously.

`stdio: 'ignore'` prevents OpenSSL's normal command-line output from being displayed.

When this function completes successfully, the certificate and private key should exist at the requested locations.

---

# 12. `ensureCertificate()`

```js
export function ensureCertificate(certPath, keyPath) {
```

## Purpose

Ensures that both the TLS certificate and private key exist.

This is the main function used before starting the HTTPS server.

---

# 13. Checking Certificate and Key

```js
const certExists = fs.existsSync(certPath);
const keyExists = fs.existsSync(keyPath);
```

The function independently checks:

```text
Certificate exists?
Private key exists?
```

---

# 14. Existing Certificate and Key

```js
if (certExists && keyExists) {
  return { generated: false };
}
```

If both files already exist, no certificate generation is performed.

The function returns:

```js
{
  generated: false
}
```

This prevents unnecessary regeneration every time the application starts.

---

# 15. Generating Missing Credentials

```js
generateSelfSignedCert(certPath, keyPath);
```

If either file is missing, the function generates a new certificate and key.

After successful generation:

```js
return { generated: true };
```

This tells the caller that certificate generation occurred.

---

# 16. `loadTlsContext()`

```js
export function loadTlsContext(certPath, keyPath) {
```

## Purpose

Reads the certificate and private key from disk.

---

## Reading Certificate

```js
cert: fs.readFileSync(certPath)
```

The certificate is read as a `Buffer`.

---

## Reading Private Key

```js
key: fs.readFileSync(keyPath)
```

The private key is also read as a `Buffer`.

---

## Returned Object

The function returns:

```js
{
  cert,
  key
}
```

This object can be supplied to Node.js TLS/HTTPS APIs.

---

# 17. `getCertExpiry()`

```js
export function getCertExpiry(certPath) {
```

## Purpose

Reads the expiration date from an X.509 certificate.

It uses OpenSSL to inspect the certificate.

---

# 18. Executing OpenSSL Certificate Inspection

```js
const output = childProcess
  .execFileSync(
    'openssl',
    ['x509', '-enddate', '-noout', '-in', certPath]
  )
  .toString();
```

The effective command is:

```text
openssl x509 -enddate -noout -in <certificate>
```

The relevant output is typically:

```text
notAfter=Jun 15 12:00:00 2027 GMT
```

---

# 19. Extracting the Expiration Date

```js
const match = output.match(/notAfter=(.+)/);
```

A regular expression searches for:

```text
notAfter=
```

and captures everything after it.

---

## Missing Expiration Information

```js
if (!match) return null;
```

If the expected format is not found, the function returns `null`.

---

# 20. Converting the Date

```js
const expiry = new Date(match[1].trim());
```

The extracted OpenSSL date string is converted into a JavaScript `Date`.

---

# 21. Invalid Date Handling

```js
return Number.isNaN(expiry.getTime()) ? null : expiry;
```

`getTime()` returns the timestamp representation of the date.

If it produces `NaN`, the parsed date is invalid.

In that case:

```text
null
```

is returned.

Otherwise, the valid `Date` object is returned.

---

# 22. `warnIfExpiringSoon()`

```js
export function warnIfExpiringSoon(
  certPath,
  warnDays,
  logger
) {
```

## Purpose

Checks how many days remain before a TLS certificate expires and logs a warning if it is within the configured warning period.

---

# 23. Logger Selection

```js
const log = logger || console;
```

A custom logger can be supplied.

If none is supplied, the standard console is used.

---

# 24. Protected Certificate Inspection

```js
try {
  const expiry = getCertExpiry(certPath);
```

Certificate inspection is wrapped in a `try/catch` so that certificate-checking failures do not crash the application.

---

# 25. Handling Missing Expiry Information

```js
if (!expiry) return null;
```

If the certificate expiration date cannot be determined, the function simply returns `null`.

---

# 26. Calculating Remaining Time

```js
const msRemaining =
  expiry.getTime() - Date.now();
```

The expiration timestamp is compared with the current timestamp.

The result is the remaining time in milliseconds.

---

# 27. Converting Milliseconds to Days

```js
const daysRemaining = Math.floor(
  msRemaining / (1000 * 60 * 60 * 24)
);
```

The calculation converts milliseconds into days:

```text
1000 ms
× 60 seconds
× 60 minutes
× 24 hours
= milliseconds per day
```

`Math.floor()` returns the number of complete days remaining.

---

# 28. Expiry Warning

```js
if (daysRemaining <= warnDays) {
```

If the certificate has reached or passed the configured warning threshold, a warning is logged.

For example:

```text
warnDays = 30
```

means certificates with 30 or fewer days remaining trigger the warning.

---

# 29. Warning Message

```js
log.warn(
  `TLS certificate ${certPath} expires in ${daysRemaining} day(s) (${expiry.toISOString()})`
);
```

The warning contains:

- Certificate path
- Remaining days
- Exact expiration timestamp

Example:

```text
TLS certificate ./cert/server.crt expires in 12 day(s) (2026-09-11T12:00:00.000Z)
```

---

# 30. Returning Remaining Days

```js
return daysRemaining;
```

The function returns the number of days remaining even when no warning is necessary.

This makes the function useful for both:

- Monitoring
- Logging

---

# 31. Error Handling

```js
} catch {
  return null;
}
```

If anything goes wrong while reading or inspecting the certificate, the function returns `null`.

This makes certificate-expiration checking non-fatal.

---

# 32. `buildSniCallback()`

```js
function buildSniCallback(sniMap) {
```

## Purpose

Creates the callback used by Node.js HTTPS/TLS for **SNI-based certificate selection**.

SNI allows the same HTTPS server to use different certificates for different hostnames.

---

# 33. TLS Context Cache

```js
const contextCache = new Map();
```

The module maintains a cache of TLS secure contexts.

Conceptually:

```text
Map
│
├── example.com → SecureContext
├── api.example.com → SecureContext
└── admin.example.com → SecureContext
```

This prevents the certificate and key from being repeatedly loaded and converted into secure contexts for every SNI request.

---

# 34. Returning `SNICallback`

```js
return function SNICallback(hostname, callback) {
```

The returned function follows Node.js's SNI callback interface.

It receives:

```text
hostname
callback
```

The hostname identifies the server name requested by the client.

The callback is used to return the corresponding TLS context.

---

# 35. Looking Up SNI Configuration

```js
const entry = sniMap[hostname];
```

The hostname is used to find its TLS configuration.

For example:

```js
{
  "example.com": {
    certPath: "./certs/example.crt",
    keyPath: "./certs/example.key"
  }
}
```

---

# 36. Unknown Hostname

```js
if (!entry) {
  callback(
    new Error(
      `No TLS configuration for hostname: ${hostname}`
    )
  );
  return;
}
```

If there is no configuration for the requested hostname, the callback receives an error.

This prevents the server from silently selecting an incorrect certificate.

---

# 37. Checking the Context Cache

```js
let ctx = contextCache.get(hostname);
```

The function first checks whether the TLS context for this hostname has already been created.

---

# 38. Loading Certificate and Key

```js
if (!ctx) {
  const { cert, key } = loadTlsContext(
    entry.certPath,
    entry.keyPath
  );
```

If there is no cached context, the certificate and private key are loaded from disk.

---

# 39. Creating a Secure Context

```js
ctx = tls.createSecureContext({
  cert,
  key
});
```

Node.js converts the certificate and private key into a TLS `SecureContext`.

This context can then be used by the TLS layer for the corresponding hostname.

---

# 40. Caching the Context

```js
contextCache.set(hostname, ctx);
```

The newly created context is stored in the cache.

Future requests for the same hostname can reuse it.

---

# 41. Returning the Context

```js
callback(null, ctx);
```

The callback receives:

```text
error = null
context = ctx
```

This tells Node.js that the appropriate TLS context has been successfully selected.

---

# 42. `createHttpsServer()`

```js
export function createHttpsServer(
  requestHandler,
  certPath,
  keyPath,
  options = {}
) {
```

## Purpose

Creates and returns an HTTPS server configured with the application's TLS certificate and private key.

This is the main high-level server creation function in the module.

---

# 43. Ensuring Certificate Availability

```js
ensureCertificate(certPath, keyPath);
```

Before creating the server, the module ensures that both the certificate and private key exist.

If they do not exist, a self-signed certificate is generated.

Therefore, the server can automatically prepare development TLS credentials when necessary.

---

# 44. Loading TLS Credentials

```js
const { cert, key } =
  loadTlsContext(certPath, keyPath);
```

The certificate and private key are read from disk.

---

# 45. HTTPS Options

```js
const httpsOptions = {
  cert,
  key
};
```

The certificate and private key are placed into the options object expected by Node.js's HTTPS server.

---

# 46. Optional SNI Configuration

```js
if (
  options.sni &&
  Object.keys(options.sni).length > 0
) {
  httpsOptions.SNICallback =
    buildSniCallback(options.sni);
}
```

SNI is enabled only when an SNI configuration exists and contains at least one hostname.

This keeps the default configuration simple while allowing multi-domain HTTPS deployments when needed.

---

# 47. Creating the HTTPS Server

```js
return https.createServer(
  httpsOptions,
  requestHandler
);
```

Node.js creates the HTTPS server using:

- TLS certificate
- Private key
- Optional SNI callback
- Application request handler

The resulting server instance is returned to the caller.

---

# 48. Complete Certificate Lifecycle

The module follows this lifecycle:

```text
                  createHttpsServer()
                         │
                         ▼
                ensureCertificate()
                         │
                ┌────────┴────────┐
                │                 │
        Files exist?          Files missing?
                │                 │
                ▼                 ▼
             Continue       Check OpenSSL
                                  │
                                  ▼
                         Generate self-signed
                            certificate
                                  │
                                  ▼
                         Load cert + key
                                  │
                                  ▼
                         HTTPS configuration
                                  │
                         ┌────────┴────────┐
                         │                 │
                      No SNI            SNI
                         │                 │
                         ▼                 ▼
                    Normal HTTPS      SNICallback
                         │                 │
                         └────────┬────────┘
                                  ▼
                           HTTPS Server
```

---

# 49. SNI Architecture

When SNI is configured:

```text
                  HTTPS Client
                       │
                 Sends hostname
                       │
                       ▼
                 SNICallback
                       │
                       ▼
                 Search sniMap
                       │
             ┌─────────┴─────────┐
             │                   │
          Found               Not Found
             │                   │
             ▼                   ▼
       Load/cache context      Error
             │
             ▼
       TLS SecureContext
             │
             ▼
       Continue TLS handshake
```

---

# 50. Certificate Caching

SNI certificate contexts are cached using:

```js
const contextCache = new Map();
```

Without caching, the server could repeatedly:

```text
Read certificate
       ↓
Read private key
       ↓
Create SecureContext
```

With caching:

```text
First request
     ↓
Load certificate/key
     ↓
Create SecureContext
     ↓
Cache context

Future requests
     ↓
Reuse cached context
```

This reduces unnecessary filesystem access and TLS context creation.

---

# 51. Self-Signed Certificate Behavior

The module automatically generates a certificate when either the certificate or private key is missing.

The generated certificate uses:

```text
RSA 2048-bit key
Validity: 365 days
Common Name: localhost
```

This is primarily appropriate for local development/testing.

A self-signed certificate is generally not trusted automatically by normal browsers or external clients because it is not signed by a trusted Certificate Authority.

For production deployments, certificates should normally come from an appropriate trusted CA or managed certificate system.

---

# 52. Certificate Expiration Monitoring

The module provides a separate mechanism for monitoring certificate expiration:

```text
getCertExpiry()
       │
       ▼
Read certificate expiry
       │
       ▼
Calculate remaining days
       │
       ▼
warnIfExpiringSoon()
       │
       ├── Above threshold → no warning
       │
       └── At/below threshold → log warning
```

This allows the application to detect certificates that need replacement before they expire.

---

# 53. Public API

The module exports:

```js
isOpensslAvailable()
opensslManualCommand()
ensureCertificate()
loadTlsContext()
getCertExpiry()
warnIfExpiringSoon()
createHttpsServer()
```

Their responsibilities are:

| Function | Purpose |
|---|---|
| `isOpensslAvailable()` | Check whether OpenSSL is accessible |
| `opensslManualCommand()` | Generate a manual certificate command |
| `ensureCertificate()` | Ensure certificate and key exist |
| `loadTlsContext()` | Load certificate and private key |
| `getCertExpiry()` | Read certificate expiration date |
| `warnIfExpiringSoon()` | Warn about certificates nearing expiration |
| `createHttpsServer()` | Create the configured HTTPS server |

Internal helper functions are:

| Function | Purpose |
|---|---|
| `ensureDirForFile()` | Create parent directories |
| `generateSelfSignedCert()` | Generate self-signed credentials |
| `buildSniCallback()` | Build the SNI certificate-selection callback |

---

# 54. Error Handling Strategy

The module uses different strategies depending on the operation.

### OpenSSL availability

Returns:

```text
false
```

from `isOpensslAvailable()`.

### Certificate generation

Throws an explicit error if OpenSSL is unavailable.

### Certificate expiry checking

Returns:

```text
null
```

when inspection fails.

### SNI lookup

Returns an error through the TLS callback when no hostname configuration exists.

This provides different levels of failure handling depending on whether the operation is:

- Informational
- Required for startup
- Part of the TLS handshake

---

# 55. Security Considerations

## Private Key Protection

The private key loaded by:

```js
loadTlsContext()
```

is sensitive.

Its file permissions and storage location should therefore be properly protected.

## Self-Signed Certificates

Automatically generated self-signed certificates are convenient for development but should not automatically be treated as production certificates.

## Https Transport

The final server created by:

```js
https.createServer()
```

provides encrypted transport between the client and server when TLS is successfully established.

## SNI Isolation

Unknown SNI hostnames are explicitly rejected instead of silently receiving an arbitrary certificate configuration.

---

# 56. Relationship Between the Main Functions

The main dependencies between functions are:

```text
createHttpsServer()
        │
        ├── ensureCertificate()
        │       │
        │       └── generateSelfSignedCert()
        │                │
        │                ├── isOpensslAvailable()
        │                └── ensureDirForFile()
        │
        ├── loadTlsContext()
        │
        └── buildSniCallback()
                │
                ├── loadTlsContext()
                │
                └── tls.createSecureContext()
```

Certificate monitoring operates independently:

```text
warnIfExpiringSoon()
        │
        └── getCertExpiry()
                 │
                 └── OpenSSL
```

---

# 57. Example SNI Configuration

A possible SNI configuration could look like:

```js
const options = {
  sni: {
    'example.com': {
      certPath: './certs/example.crt',
      keyPath: './certs/example.key'
    },

    'api.example.com': {
      certPath: './certs/api.crt',
      keyPath: './certs/api.key'
    }
  }
};
```

The HTTPS server can then select the appropriate TLS credentials based on the hostname.

Conceptually:

```text
example.com
     │
     ▼
example certificate

api.example.com
     │
     ▼
api certificate
```

---

# 58. Overall Module Architecture

```text
                         tls.js
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
 Certificate           Certificate          HTTPS
 Management            Monitoring           Server
        │                  │                  │
        ▼                  ▼                  ▼
ensureCertificate()   getCertExpiry()   createHttpsServer()
        │                  │                  │
        ▼                  ▼                  ▼
OpenSSL generation   Expiry calculation   TLS configuration
                                             │
                                             ▼
                                        Optional SNI
                                             │
                                             ▼
                                      SecureContext cache
```

---

# 59. Summary

`tls.js` is responsible for establishing and managing the application's TLS/HTTPS layer.

Its major responsibilities are:

1. Detect whether OpenSSL is available.
2. Generate self-signed certificates when required.
3. Create certificate directories automatically.
4. Avoid regenerating existing certificates.
5. Load certificates and private keys into memory.
6. Inspect certificate expiration dates.
7. Warn when certificates are approaching expiration.
8. Support multiple certificates through SNI.
9. Cache TLS secure contexts for SNI hostnames.
10. Create HTTPS servers using Node.js's native HTTPS implementation.
11. Provide clear errors when required TLS configuration is unavailable.

The overall flow is:

```text
                 TLS Configuration
                        │
                        ▼
               Certificate Exists?
                  /           \
                Yes            No
                 │              │
                 │          OpenSSL
                 │              │
                 │              ▼
                 │       Generate Certificate
                 │              │
                 └──────┬───────┘
                        ▼
                 Load Certificate
                  + Private Key
                        │
                        ▼
                  HTTPS Options
                        │
                 ┌──────┴──────┐
                 │             │
               Normal          SNI
                 │             │
                 │        Select hostname
                 │             │
                 │        Cached Context
                 │             │
                 └──────┬──────┘
                        ▼
                  HTTPS Server
```

In short, **`tls.js` provides the complete TLS foundation for the application, from certificate generation and expiration monitoring to secure-context management, SNI support, and HTTPS server creation.**