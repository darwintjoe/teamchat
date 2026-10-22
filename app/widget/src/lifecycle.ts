// Subscription lifecycle guard. The live query is only held while the widget is open AND visible.
//
// This is the S5 mitigation: hiding or closing the widget tears the Convex subscription down
// instead of leaving a per-widget listener alive on the deployment. The class is deliberately
// DOM-free so it can be unit-tested in Node.

export class SubscriptionGate {
  private unsubscribe: (() => void) | null = null;
  private open = false;
  private visible = true;

  constructor(
    private readonly subscribe: () => () => void,
    private readonly onActiveChange?: (active: boolean) => void,
  ) {}

  get active(): boolean {
    return this.open && this.visible;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.sync();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.sync();
  }

  close(): void {
    this.open = false;
    this.visible = false;
    this.teardown();
    this.onActiveChange?.(false);
  }

  private sync(): void {
    if (this.active) this.activate();
    else this.teardown();
  }

  private activate(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.subscribe();
    this.onActiveChange?.(true);
  }

  private teardown(): void {
    if (this.unsubscribe === null) return;
    const stop = this.unsubscribe;
    this.unsubscribe = null;
    try {
      stop();
    } catch {
      // A closed socket can throw here; teardown must still be idempotent.
    }
    this.onActiveChange?.(false);
  }
}
