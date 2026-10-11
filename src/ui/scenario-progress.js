export function scenarioProgressText(pool) {
  const sent = Math.max(0, Number(pool?.totalSentPrompts ?? pool?.verifiedSends ?? 0));
  const received = Math.max(0, Number(pool?.totalReceivedResponses ?? 0));
  return `Надіслано промптів: ${sent}. Отримано відповідей: ${received}.`;
}
