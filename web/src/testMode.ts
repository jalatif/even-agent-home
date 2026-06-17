export function isFixtureMode() { return false; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logLifecycleEvent(event: any) {
  logTestEvent('lifecycle', { kind: event });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logRecordingEvent(event: any) {
  logTestEvent('recording', event);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logStateWork(state: any) {
  logTestEvent('state', { screen: state.screen, ...state });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logBridgeQueueDepth(args: any) {
  logTestEvent('bridge.queueDepth', args);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logInputDispatch(args: any) {
  logTestEvent('input.dispatch', args);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logTestEvent(event: string, data?: any) {
  console.log(`[AgentHomeTest] ${JSON.stringify({ event, ...data, ts: Date.now() })}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarizeScreenModel(model: any) { return JSON.stringify(model); }
export function nowMs() { return Date.now(); }
export type BridgeQueueDepthReason = string;
