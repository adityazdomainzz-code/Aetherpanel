import React from 'react';
import { ShieldCheck, LifeBuoy, Server as ServerIcon, Wallet } from 'lucide-react';

/** Shown instead of the deploy wizard / deposit forms: only an administrator creates servers and adds credits. */
export const SelfServiceLocked: React.FC<{ kind: 'deploy' | 'funds'; onNavigate: (page: string, params?: any) => void; compact?: boolean }> = ({ kind, onNavigate, compact }) => {
  const deploy = kind === 'deploy';
  return (
    <div className={`${compact ? 'p-6' : 'p-10 max-w-2xl mx-auto mt-6'} rounded-3xl bg-zinc-900/80 border border-zinc-800 text-center space-y-4`}>
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
        {deploy ? <ServerIcon className="h-7 w-7" /> : <Wallet className="h-7 w-7" />}
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold text-white flex items-center justify-center gap-2">
          <ShieldCheck className="h-5 w-5 text-amber-400" />
          {deploy ? 'Servers are created by the admin' : 'Credits are added by the admin'}
        </h2>
        <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
          {deploy
            ? 'You cannot create a Minecraft or bot server yourself. Ask an administrator - they create it for your account and the plan price is taken from your credits.'
            : 'You cannot add funds yourself. An administrator adds credits to your account. Your balance is used when the admin creates a server for you.'}
        </p>
      </div>
      <button
        onClick={() => onNavigate('support')}
        className="px-5 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-black font-bold text-xs inline-flex items-center gap-2 transition"
      >
        <LifeBuoy className="h-4 w-4" /> {deploy ? 'Request a server' : 'Contact admin'}
      </button>
    </div>
  );
};

export default SelfServiceLocked;
