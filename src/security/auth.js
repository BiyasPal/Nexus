import crypto from 'node:crypto';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

export function isValidApiKey(headerValue, validKeys) {
  if (!headerValue) return false;
  return validKeys.some((key) => safeEqual(headerValue, key));
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(payloadB64, hmacSecret) {
  return crypto.createHmac('sha256', hmacSecret).update(payloadB64).digest('hex');
}

export function generateToken(claims, hmacSecret, tokenExpirySeconds) {
  const payload = {
    ...claims,
    exp: Date.now() + tokenExpirySeconds * 1000
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64, hmacSecret);

  return `${payloadB64}.${signature}`;
}

export function verifyToken(token, hmacSecret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'invalid' };
  }

  const [payloadB64, signature] = token.split('.');

  if (!payloadB64 || !signature) {
    return { valid: false, reason: 'invalid' };
  }

  const expectedSignature = sign(payloadB64, hmacSecret);

  if (!safeEqual(signature, expectedSignature)) {
    return { valid: false, reason: 'invalid' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, reason: 'invalid' };
  }

  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { valid: false, reason: 'expired', payload };
  }

  return { valid: true, reason: 'token', payload };
}

export function createAuthenticator(authConfig, logger) {
  const log = logger || console;

  const headerName = (authConfig.headerName || 'X-API-Key').toLowerCase();
  const validKeys = authConfig.keys || [];
  const requiredByDefault = authConfig.requiredByDefault === true;
  const hmacSecret = authConfig.hmacSecret || null;
  const tokenExpirySeconds = authConfig.tokenExpirySeconds || 3600;

  function isRequired(routeAuthOverride) {
    if (routeAuthOverride == null) return requiredByDefault;
    if (typeof routeAuthOverride === 'boolean') return routeAuthOverride;
    if (typeof routeAuthOverride.required === 'boolean') return routeAuthOverride.required;
    return requiredByDefault;
  }

  function logFailure(reason, routeLabel) {
    log.info(
      `auth failed (${reason})${routeLabel ? ` for route ${routeLabel}` : ''}`
    );
  }

  function authenticate(headers, routeAuthOverride, routeLabel) {
    if (!isRequired(routeAuthOverride)) {
      return { authenticated: true, reason: 'not_required' };
    }

    const headerValue = headers ? headers[headerName] : undefined;

    if (!headerValue) {
      logFailure('missing', routeLabel);
      return { authenticated: false, reason: 'missing' };
    }

    if (isValidApiKey(headerValue, validKeys)) {
      return { authenticated: true, reason: 'api_key' };
    }

    if (hmacSecret) {
      const result = verifyToken(headerValue, hmacSecret);

      if (result.valid) {
        return { authenticated: true, reason: 'token' };
      }

      logFailure(result.reason, routeLabel);
      return { authenticated: false, reason: result.reason };
    }

    logFailure('invalid', routeLabel);
    return { authenticated: false, reason: 'invalid' };
  }

  function issueToken(claims) {
    if (!hmacSecret) {
      throw new Error('cannot issue token: auth.hmacSecret is not configured');
    }
    return generateToken(claims, hmacSecret, tokenExpirySeconds);
  }

  return {
    authenticate,
    issueToken
  };
}