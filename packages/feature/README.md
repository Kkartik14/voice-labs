# Voice Labs embeddable feature

This package contains the project-scoped Lab UI for a host application. It
does not include the Voice Labs server, local navigation, provider credentials,
or Platform-private modules.

The host supplies its short-lived Voice Labs access token and may supply an API
base URL when it does not proxy the Voice Labs API:

```tsx
import { VoiceLabsFeature } from "@voice-labs/feature";
import "@voice-labs/feature/styles.css";

<VoiceLabsFeature accessToken={token} />
```

React and React DOM are peer dependencies. Build the package from the repository
root with `pnpm build:feature`. The package remains private and is not publishable
while its name and license are provisional. Platform development can consume it
through a local `file:` dependency after the feature build.
