// The app entry. Background tasks must be defined before the app loads, because a push wake can
// start the bundle headless (nothing rendered) to run only the task (Phase 12). The polyfills come
// first: the task reaches the message engine, which needs them.
import './src/polyfills';
import './src/push/task';
import 'expo-router/entry';
