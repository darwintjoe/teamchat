/** Small date helpers for the thin client (no date library). */

export function formatClock(ts: number): string {
  if (ts <= 0) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDay(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function formatShort(ts: number): string {
  if (ts <= 0) return "";
  const date = new Date(ts);
  const today = new Date();
  if (sameDay(date, today)) return formatClock(ts);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
