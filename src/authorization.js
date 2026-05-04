import crypto from "node:crypto";

function hmac(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function issueDelegation(claims, secret) {
  const payload = JSON.stringify(claims);
  const signature = hmac(payload, secret);
  return {
    claims,
    signature
  };
}

export function verifyDelegation(delegation, request, secret, now = new Date()) {
  const payload = JSON.stringify(delegation.claims);
  const expected = hmac(payload, secret);

  if (expected !== delegation.signature) {
    return { allowed: false, reason: "invalid delegation signature" };
  }

  if (new Date(delegation.claims.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "delegation expired" };
  }

  if (!delegation.claims.permissions.includes(request.action)) {
    return { allowed: false, reason: `delegation does not allow ${request.action}` };
  }

  if (request.action === "mint" && request.amountUsd > delegation.claims.maxMintUsd) {
    return { allowed: false, reason: "mint amount exceeds delegated cap" };
  }

  if (request.action === "trade" && request.amountUsd > delegation.claims.maxTradeUsd) {
    return { allowed: false, reason: "trade amount exceeds delegated cap" };
  }

  return {
    allowed: true,
    principal: delegation.claims.principal,
    agentId: delegation.claims.agentId
  };
}
