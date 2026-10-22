import { mount } from "./embed";

export { mount };
export type { MountOptions, WidgetHandle } from "./embed";

declare global {
  interface Window {
    TeamChatWidget: { mount: typeof mount };
  }
}

window.TeamChatWidget = { mount };
