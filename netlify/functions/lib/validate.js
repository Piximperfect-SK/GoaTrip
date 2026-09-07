// Input sanitization/validation helpers, ported from the original Apps Script
// backend's sanitizeText_/sanitizeNumber_/validateAction_ pattern.

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    value = String(value);
  }
  value = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (value.length > maxLen) value = value.slice(0, maxLen);
  return value;
}

function sanitizeNumber(value, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function normalizeDepositType(value) {
  return value === 'withdrawal' ? 'withdrawal' : 'deposit';
}

// Validates payload against a schema map: { field: { type, maxLen?, min?, max?, required? } }
// Returns an error string, or null if the payload passes.
function validatePayload(schema, payload) {
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    return 'Missing or invalid payload.';
  }
  for (const field in schema) {
    const rule = schema[field];
    const val = payload[field];

    if (rule.required && (val === undefined || val === null || val === '')) {
      return `Missing required field: ${field}`;
    }
    if (val === undefined || val === null) continue;

    if (rule.type === 'string') {
      if (typeof val !== 'string') return `Field ${field} must be text.`;
      if (val.length > rule.maxLen) return `Field ${field} is too long (max ${rule.maxLen} characters).`;
    }
    if (rule.type === 'number') {
      const n = sanitizeNumber(val, rule.min, rule.max);
      if (n === null) return `Field ${field} must be a number between ${rule.min} and ${rule.max}.`;
    }
    if (rule.type === 'array') {
      if (!Array.isArray(val)) return `Field ${field} must be a list.`;
      if (rule.maxLen && val.length > rule.maxLen) return `Field ${field} has too many items.`;
      for (const item of val) {
        if (typeof item !== 'string' || item.length > 80) return `Field ${field} has an invalid entry.`;
      }
    }
  }
  return null;
}

module.exports = { sanitizeText, sanitizeNumber, normalizeDepositType, validatePayload };
