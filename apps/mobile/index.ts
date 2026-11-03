// The app entry. Background tasks must be defined before the app loads, because a push wake can
// start the bundle headless (nothing rendered) to run only the task (Phase 12). The polyfills come
// first: the task reaches the message engine, which needs them. On iOS a VoIP push can launch
// the app for a call: `calls/voip` listens for it from the start (Phase 29).
import './src/polyfills';
import './src/push/task';
import './src/calls/voip';
import 'expo-router/entry';
