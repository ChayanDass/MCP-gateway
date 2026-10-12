import { useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError, type Me } from "./api";
import { Login } from "./Login";
import { Shell } from "./Shell";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);

  // Ask who is signed in. Only a 401 means "signed out". A network failure gets a retry screen,
  // so a gateway restart does not look like a logout.
  const check = useCallback(() => {
    setUnreachable(false);
    api<Me>("GET", "/api/auth/me")
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setUnreachable(true);
      });
  }, []);

  useEffect(check, [check]);

  let page;
  if (unreachable) {
    page = (
      <div className="grid min-h-screen place-items-center p-6" role="alert">
        <div className="max-w-md space-y-3 rounded-lg border bg-card p-6 text-center">
          <h1 className="text-xl font-semibold">Can't reach the gateway</h1>
          <p className="text-sm text-muted-foreground">The dashboard is running, but the gateway isn't responding. It may be restarting.</p>
          <Button onClick={check}>Try again</Button>
        </div>
      </div>
    );
  } else if (me === undefined) {
    page = <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  } else if (me === null) {
    page = <Login onLogin={setMe} />;
  } else {
    page = <Shell me={me} onLogout={() => setMe(null)} />;
  }

  return (
    <>
      {page}
      <Toaster richColors closeButton />
    </>
  );
}
