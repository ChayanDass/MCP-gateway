// Short messages in a corner. Any part of the app can call notify().
import { toast } from "sonner";

export type Tone = "ok" | "error" | "info";

export function notify(message: string, tone: Tone = "info") {
  if (tone === "error") toast.error(message);
  else if (tone === "ok") toast.success(message);
  else toast(message);
}
