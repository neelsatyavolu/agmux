export function isPermissionRequestEvent(type) {
  return type === "permission.asked" || type === "permission.updated" || type === "permission.requested";
}

export function isQuestionRequestEvent(type) {
  return type === "question.asked" || type === "question.updated" || type === "question.requested";
}

export function openCodePermissionReply(decision) {
  if (decision === "accept") return "once";
  if (decision === "acceptForSession") return "always";
  return "reject";
}

export function isBypassPermissionMode(mode) {
  return mode === "auto" || mode === "full-access" || mode === "bypassPermissions" || mode === "full";
}
