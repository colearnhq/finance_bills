"use client";
import { useActionState } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" placeholder="Email" autoComplete="username" className="input w-full" />
      <input name="password" type="password" placeholder="Password" autoComplete="current-password" className="input w-full" />
      {state.error && <p className="alert-error">{state.error}</p>}
      <button disabled={pending} className="btn btn-primary w-full">{pending ? "Masuk…" : "Masuk"}</button>
    </form>
  );
}
