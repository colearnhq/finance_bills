import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-5 p-8">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/colearn-logo.svg" alt="CoLearn" width={120} height={26} className="mb-4" />
          <h1 className="text-2xl">AP Hub</h1>
          <p className="muted text-sm">Masuk untuk melanjutkan</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
