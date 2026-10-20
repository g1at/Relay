#pragma once
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
// Shared only between Relay and its private launcher. PIDs are diagnostic data;
// termination and confirmation exclusively use the retained Job Object handle.
struct RelayJobState {
  volatile LONG canceled;
  volatile LONG sdkPid;
  volatile LONG spawnState; // 0 pending, 1 assigned, 2 resumed, 3 spawn failed
  volatile LONG spawnError;
};
