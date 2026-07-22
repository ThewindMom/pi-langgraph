const CREDENTIAL_KEY = String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|aws_secret_access_key|aws_session_token|google_application_credentials|gcp_service_account|azure_client_secret|private[_-]?key|github[_-]?token|openai[_-]?api[_-]?key|slack[_-]?token)`;
const ASSIGNMENT_PREFIX = String.raw`((?:["']?${CREDENTIAL_KEY}["']?)\s*[:=]\s*)`;
const QUOTED_ASSIGNMENT = new RegExp(`${ASSIGNMENT_PREFIX}(["'])([^"']*)\\2`, "gi");
const UNQUOTED_ASSIGNMENT = new RegExp(`${ASSIGNMENT_PREFIX}([^\\s,;}]*)`, "gi");
const AUTHORIZATION = /(Authorization\s*:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/=:-]+/gi;
const PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9_])/g;

export function redactOutput(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(QUOTED_ASSIGNMENT, "$1$2[REDACTED]$2")
    .replace(UNQUOTED_ASSIGNMENT, "$1[REDACTED]")
    .replace(AUTHORIZATION, "$1[REDACTED]")
    .replace(KNOWN_TOKEN, "[REDACTED]");
}
