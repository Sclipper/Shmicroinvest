import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { useSessionQuery } from './session.tsx';
import { DialogProvider } from './components/dialogs.tsx';
import { Spinner } from './components/ui.tsx';
import { Login, NewCompanyForm } from './screens/Login.tsx';
import { Dialog } from './components/ui.tsx';
import { Shell } from './shell/Shell.tsx';
import { WorkspaceProvider } from './shell/workspace.tsx';
import { SCREENS } from './registry.tsx';
import { UserSkin } from './skin.ts';

export function App() {
  const session = useSessionQuery();
  const qc = useQueryClient();
  const [loggingOut, setLoggingOut] = useState(false);
  const [newCompany, setNewCompany] = useState(false);
  if (session.isLoading || loggingOut) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!session.data) return <Login />;
  const leave = async () => {
    setLoggingOut(true);
    await api.post('/logout');
    qc.clear();
    setLoggingOut(false);
  };
  return (
    <DialogProvider>
      <WorkspaceProvider key={`${session.data.company.db}:${session.data.user.id}`} screens={SCREENS}>
        <UserSkin />
        <Shell
          screens={SCREENS}
          onCommand={(c) => {
            if (c === 'logout' || c === 'chooseCompany') void leave();
            if (c === 'newCompany') setNewCompany(true);
          }}
        />
        {newCompany && (
          <Dialog title="Нова фирма" onClose={() => setNewCompany(false)} width={460}>
            <NewCompanyForm
              firstRun={false}
              onCancel={() => setNewCompany(false)}
              onDone={async () => {
                setNewCompany(false);
                await qc.invalidateQueries();
              }}
            />
          </Dialog>
        )}
      </WorkspaceProvider>
    </DialogProvider>
  );
}
