import { createGameApi, readGameMode } from './client/api.js';
import { createGameController } from './client/controller.js';
import { createStorage } from './client/storage.js';
import { createGameInput } from './ui/input.js';
import { createGameView } from './ui/view.js';

const mode = readGameMode(window.location.search);
const storage = createStorage(() => window.localStorage);
const api = createGameApi();
const view = createGameView({ document, window, mode, storage });
const controller = createGameController({ api, mode, view, storage, window, document });
const input = createGameInput({
  view,
  window,
  document,
  readOnly: mode.readOnly,
  getSnapshot: controller.getSnapshot,
  isBusy: controller.isBusy,
  onPlace: controller.place,
});

window.BlockBlast = Object.freeze({
  readOnly: mode.readOnly,
  getSnapshot: () => structuredClone(controller.getSnapshot()),
  refresh: controller.poll,
  place: controller.place,
  reset: controller.reset,
  undo: controller.undo,
});

void controller.start(input);
