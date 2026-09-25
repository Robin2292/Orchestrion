// Product IPC has one authenticated registration path. Business delegation lives
// in the utility host; the main-process DesktopRuntime registration was removed.
export { registerBackgroundIpc as registerIpc } from "./background/ipc";
