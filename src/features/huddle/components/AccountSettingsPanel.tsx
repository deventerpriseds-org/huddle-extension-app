import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";

export function AccountSettingsPanel() {
  const { isAuthenticated, user, signIn, signOut } = useAuth();
  const { query, setUsername, setDisplayName, addEmail, removeEmail } = useProfile();

  const [usernameDraft, setUsernameDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const bundle = query.data ?? null;

  useEffect(() => {
    if (bundle) {
      setUsernameDraft(bundle.profile.username);
      setDisplayNameDraft(bundle.profile.display_name ?? "");
    }
  }, [bundle]);

  if (!isAuthenticated) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm">
        <p className="mb-3">
          Sign in to create your username and manage the emails linked to your
          account.
        </p>
        <Button onClick={() => void signIn()}>Sign in</Button>
      </div>
    );
  }

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading account…</p>;
  }

  if (query.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="font-medium text-destructive">Couldn't load account</p>
        <p className="text-destructive/80">{(query.error as Error).message}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!bundle) return null;

  const handleUsername = async () => {
    setError(null);
    try {
      await setUsername.mutateAsync(usernameDraft);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDisplayName = async () => {
    setError(null);
    try {
      await setDisplayName.mutateAsync(displayNameDraft.trim() || null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleAddEmail = async () => {
    setError(null);
    try {
      await addEmail.mutateAsync(newEmail);
      setNewEmail("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRemoveEmail = async (id: string) => {
    setError(null);
    try {
      await removeEmail.mutateAsync(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="text-sm">
          <div className="font-medium">Signed in</div>
          <div className="text-muted-foreground">{user?.username ?? user?.name}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <div className="flex gap-2">
          <Input
            id="username"
            value={usernameDraft}
            onChange={(e) => setUsernameDraft(e.target.value)}
            placeholder="your-handle"
          />
          <Button
            onClick={handleUsername}
            disabled={
              setUsername.isPending ||
              usernameDraft.trim().toLowerCase() === bundle.profile.username.toLowerCase()
            }
          >
            {setUsername.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          3–30 characters. Lowercase letters, digits, underscore, hyphen.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="display-name">Display name (optional)</Label>
        <div className="flex gap-2">
          <Input
            id="display-name"
            value={displayNameDraft}
            onChange={(e) => setDisplayNameDraft(e.target.value)}
            placeholder="How your name appears"
          />
          <Button
            onClick={handleDisplayName}
            disabled={
              setDisplayName.isPending ||
              (displayNameDraft.trim() || null) === (bundle.profile.display_name ?? null)
            }
          >
            {setDisplayName.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Your emails</Label>
        <ul className="divide-y rounded-md border">
          {bundle.emails.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">
              No emails yet.
            </li>
          ) : (
            bundle.emails.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-2 p-2 text-sm"
              >
                <span className="truncate">{e.email}</span>
                {e.source === "entra" ? (
                  <span className="text-xs text-muted-foreground">Sign-in</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRemoveEmail(e.id)}
                    disabled={removeEmail.isPending}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))
          )}
        </ul>
        <div className="flex gap-2 pt-1">
          <Input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="add another email"
          />
          <Button
            onClick={handleAddEmail}
            disabled={addEmail.isPending || !newEmail.trim()}
          >
            {addEmail.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Add any additional email addresses that belong to you. Your sign-in
          email can't be removed.
        </p>
      </div>
    </div>
  );
}
