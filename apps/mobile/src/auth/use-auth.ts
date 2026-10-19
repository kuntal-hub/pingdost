import { useStore } from 'zustand';

import { authStore } from '@/api';

import { stageOf, type AppStage, type AuthActions, type AuthState } from './auth-store';

/** Reads from the auth store, re-rendering when the selected value changes. */
export function useAuth<T>(selector: (state: AuthState & AuthActions) => T): T {
  return useStore(authStore, selector);
}

export function useAppStage(): AppStage {
  return useAuth(stageOf);
}
