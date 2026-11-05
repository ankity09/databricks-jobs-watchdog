import { Button } from "@databricks/appkit-ui/react";
import { RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ReloadJobList } from "../../hooks/useJobList";
import { type ApiError, toApiError } from "../../lib/api";

export interface ReloadButtonProps {
  onReload: ReloadJobList;
  /** Runs once the newest job list has loaded. */
  onReloaded: () => void;
  /** The button's text; Reload by default. */
  children?: ReactNode;
}

/**
 * The Reload button of a save conflict. It reloads the job list, then calls
 * onReloaded. When the reload fails it says so under the button, and the
 * conflict stays, so the next save cannot go out from the old version.
 */
export function ReloadButton({ onReload, onReloaded, children = "Reload" }: ReloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    let error: ApiError | null;
    try {
      error = await onReload();
    } catch (thrown) {
      error = toApiError(thrown);
    }
    setBusy(false);
    if (error) setFailure(error.message);
    else onReloaded();
  };
  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void run()}>
        <RotateCw aria-hidden="true" />
        {children}
      </Button>
      {failure ? <p className="basis-full text-sm text-destructive">The job list did not reload. {failure}</p> : null}
    </>
  );
}
