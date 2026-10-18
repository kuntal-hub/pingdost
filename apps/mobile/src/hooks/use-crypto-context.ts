import { useEffect, useState } from 'react';

import { getCryptoContext, type CryptoContext } from '@/crypto/bootstrap';

export type CryptoState =
  | { status: 'loading' }
  | { status: 'ready'; context: CryptoContext }
  | { status: 'error'; message: string };

export function useCryptoContext(): CryptoState {
  const [state, setState] = useState<CryptoState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    getCryptoContext().then(
      (context) => active && setState({ status: 'ready', context }),
      (error: unknown) =>
        active &&
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'crypto setup failed',
        }),
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}
