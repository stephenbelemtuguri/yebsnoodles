#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

CONFIG_FILE=${MOMO_SMS_CONFIG_FILE:-"$HOME/.config/yebs-momo-bridge.env"}
if [[ -f $CONFIG_FILE ]]; then
  chmod 600 "$CONFIG_FILE"
  source "$CONFIG_FILE"
fi

API_URL=${MOMO_SMS_API_URL:-}
TOKEN=${MOMO_SMS_INGEST_TOKEN:-}
DEVICE_ID=${MOMO_SMS_DEVICE_ID:-}
POLL_SECONDS=${MOMO_SMS_POLL_SECONDS:-300}
POLL_LIMIT=${MOMO_SMS_POLL_LIMIT:-50}
STATE_DIR=${MOMO_SMS_STATE_DIR:-"$HOME/.local/state/yebs-momo-bridge"}
ONCE=false

if [[ ${1:-} == "--once" ]]; then
  ONCE=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--once]\n' "$0" >&2
  exit 2
fi

if [[ ! $API_URL =~ ^https://[^[:space:]\"\\]+/api/payments/momo/sms/ingest$ ]]; then
  printf 'MOMO_SMS_API_URL must be the HTTPS SMS-ingest endpoint.\n' >&2
  exit 2
fi
if [[ ! $TOKEN =~ ^[A-Za-z0-9._~-]{32,200}$ ]]; then
  printf 'MOMO_SMS_INGEST_TOKEN must be a 32-200 character URL-safe secret.\n' >&2
  exit 2
fi
if [[ -z $DEVICE_ID || ${#DEVICE_ID} -gt 100 ]]; then
  printf 'Set MOMO_SMS_DEVICE_ID to a stable, private device identifier.\n' >&2
  exit 2
fi
if [[ ! $POLL_SECONDS =~ ^[0-9]+$ || $POLL_SECONDS -lt 60 ]]; then
  printf 'MOMO_SMS_POLL_SECONDS must be at least 60.\n' >&2
  exit 2
fi
if [[ ! $POLL_LIMIT =~ ^[0-9]+$ || $POLL_LIMIT -lt 1 || $POLL_LIMIT -gt 100 ]]; then
  printf 'MOMO_SMS_POLL_LIMIT must be between 1 and 100.\n' >&2
  exit 2
fi
if [[ -z ${MOMO_SMS_ALLOWED_SENDERS:-} ]]; then
  printf 'Set MOMO_SMS_ALLOWED_SENDERS to the official MoMo sender ID(s).\n' >&2
  exit 2
fi

for command in termux-sms-list curl jq sha256sum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing command: %s\n' "$command" >&2
    exit 2
  fi
done

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
LOCK_DIR="$STATE_DIR/lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf 'The SMS bridge is already running.\n' >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

STATE_FILE="$STATE_DIR/processed-message-ids"
touch "$STATE_FILE"
chmod 600 "$STATE_FILE"
CURL_CONFIG=$(mktemp "$STATE_DIR/curl-config.XXXXXX")
trap 'rm -f "$CURL_CONFIG"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
{
  printf 'url = "%s"\n' "$API_URL"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
  printf 'header = "Content-Type: application/json"\n'
  printf 'request = "POST"\n'
} > "$CURL_CONFIG"
chmod 600 "$CURL_CONFIG"

ALLOWED_SENDERS=$(jq -cn --arg senders "$MOMO_SMS_ALLOWED_SENDERS" \
  '$senders | split(",") | map(ascii_downcase | gsub("[ -]"; "")) | map(select(length > 0))')

mark_processed() {
  printf '%s\n' "$1" >> "$STATE_FILE"
  local trimmed="$STATE_DIR/processed-message-ids.tmp"
  tail -n 2000 "$STATE_FILE" > "$trimmed"
  mv "$trimmed" "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

poll_inbox() {
  local messages
  if ! messages=$(termux-sms-list -t inbox -l "$POLL_LIMIT"); then
    printf 'Could not read the SMS inbox; will retry.\n' >&2
    return
  fi
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<< "$messages"; then
    printf 'Termux:API returned an unexpected inbox response; will retry.\n' >&2
    return
  fi

  while IFS= read -r message; do
    local sender sms message_id payload response response_body http_code terminal
    sender=$(jq -r '.sender' <<< "$message")
    sms=$(jq -r '.sms' <<< "$message")
    message_id=$(jq -r '.messageId' <<< "$message")
    if [[ -z $sms || ${#sms} -gt 1000 ]]; then
      continue
    fi
    if [[ ! $message_id =~ ^[A-Za-z0-9._:-]{1,200}$ ]]; then
      message_id=$(printf '%s' "$message_id" | sha256sum | cut -d ' ' -f 1)
    fi
    if grep -Fqx -- "$message_id" "$STATE_FILE"; then
      continue
    fi

    payload=$(jq -cn --arg deviceId "$DEVICE_ID" --arg messageId "$message_id" \
      --arg sender "$sender" --arg sms "$sms" \
      '{deviceId:$deviceId,messageId:$messageId,sender:$sender,sms:$sms}')
    if response=$(printf '%s' "$payload" | curl --config "$CURL_CONFIG" \
      --silent --show-error --max-time 25 --write-out $'\n%{http_code}' \
      --data-binary @-); then
      http_code=${response##*$'\n'}
      response_body=${response%$'\n'*}
    else
      printf 'SMS bridge request failed; will retry on the next poll.\n' >&2
      continue
    fi

    terminal=$(jq -r '(.terminal // false) or (.duplicate // false) or (.needsReview // false) or (.success // false)' \
      2>/dev/null <<< "$response_body" || printf 'false')
    if [[ $http_code == 401 || $http_code == 503 ]]; then
      printf 'SMS bridge authentication or server configuration failed (HTTP %s).\n' "$http_code" >&2
      return 1
    fi
    if [[ $terminal == true ]]; then
      mark_processed "$message_id"
      printf 'Processed an MoMo SMS (HTTP %s).\n' "$http_code"
    elif [[ $http_code =~ ^4[0-9][0-9]$ && $http_code != 404 && $http_code != 409 ]]; then
      mark_processed "$message_id"
      printf 'SMS rejected and not retried (HTTP %s).\n' "$http_code" >&2
    else
      printf 'SMS not matched yet (HTTP %s); will retry on the next poll.\n' "$http_code"
    fi
  done < <(jq -c --argjson allowed "$ALLOWED_SENDERS" '
    .[]? | . as $message
    | (($message.number // $message.sender // "") | tostring | ascii_downcase | gsub("[ -]"; "")) as $sender
    | select(($allowed | index($sender)) != null)
    | {sender:($message.number // $message.sender // "" | tostring),
       sms:($message.body // ""),
       messageId:($message.id // $message.msg_id //
         (($message.received // $message.date // "" | tostring) + ":" + $sender + ":" + ($message.body // "")))}
  ' <<< "$messages")
}

while true; do
  poll_inbox || exit $?
  if [[ $ONCE == true ]]; then
    exit 0
  fi
  sleep "$POLL_SECONDS"
done
