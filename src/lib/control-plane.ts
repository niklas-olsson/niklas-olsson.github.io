// SPDX-License-Identifier: Apache-2.0
import { createCloudControlPlane } from "./cloud";
import { createWorkspaceCloudProvider } from "./cloud-workspace";
import { workspace } from "./machines";
import * as volumeStorage from "./volume-store";

/** One registry and operation history, shared by the UI and page API. */
export const cloud = createCloudControlPlane(
  createWorkspaceCloudProvider(workspace, volumeStorage),
);
workspace.registerReloadGuard(cloud.assertSettled);
