# Bendbound

`bendbound-logo.png` is the approved logo: the open red road, white location
pin and Bendbound wordmark on black. It is the second of the two final previews
selected on 4 October 2026, copied unchanged from the image generator output.

The app icon, Android icon, web favicon and Profile footer use this asset.
Android uses the standard icon instead of placing the full wordmark into an
adaptive foreground layer, whose safe-area mask would crop the lettering.
The previous artwork is archived as `original-icon.png`, not an active app asset.

The display name is Bendbound; the npm package, Expo slug and sole URL scheme
are `bendbound`. The existing iOS bundle identifier is unchanged.
Local data now writes to `bendbound-state-v2`. On first load without that key,
the app reads the legacy key and saves the restored state under the new key.
The legacy data is retained as a recovery backup. New data always takes priority;
a failed read or invalid stored payload never triggers a defaults-only overwrite.
Only generated place labels are updated; user-authored titles and places are
untouched. Historical strings remain only in migration code and its tests.

The workspace folder has not been moved, so existing IDE tabs and terminal paths
continue to work. Changing the Expo slug can give Expo Go a separate local-data
sandbox; the key migration works within the same app sandbox, not between them.
Export important development rides before switching Expo Go project identities.
Native builds with the same bundle identifier retain their app sandbox.

Native launcher names, icons and permission text take effect in a new native
build. Expo Go retains its own launcher icon; reopen the project to refresh its
display name and project icon.
