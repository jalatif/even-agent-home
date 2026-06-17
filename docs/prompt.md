 Think extra hard. I want to build even realities g2 app called AgentHome which provides access to all agent from different providers(claude,codex,oh-my-
  pi,antigravity,pi,opencode,hermes,claudely) with ability to resume existing sessions, tap record to send new message using STT and also ability to create new session. App need
  not need to show empty sessions. I only want to have one backend service which can manage sessions categorized across different providers. We already have some backend
  functionality for this in ~/Work/agent-home although it requires different service for each provider but in this case i only want 1 service. Backend pairing can still be
  done through secure token shared b/w backend and frontend. You can also reference details from ~/Work/even-telegram around how to build/package even realities app with its
  frontend, glasses ui, testing harness using evenhub-simulator, and how to upload bundle to even hub, it has all the right details but app is for different usecase. You can also
  look into agent-home ui implementation if available online. Goal for user is to be able to run 1 backend which can manage sessions across all providers, have frontend which
  can pair with this backend using url/port and secure-token (or optional with QR code scan like in agent-home), on frontend side user once connected user should be able
  to select which agents it want to control from glasses ui (through simple toggle for now) along with dropdown for models for each agent (backend should provide this list) and on
  glasses UI when it starts it should be able to select the agent on first screen, then after selecting the agent, first option should be to create new session and then below list
  of available sessions (non-empty) which it can resume. If it resume sessions, user should have one big view where it can scroll up/down on previous messages (with upto 50
  messages) and then press tap to record new message and transcribe using STT server running on backend (having option on frontend to override it to differnt url). User should be
  able to view transcribe message with confirmation screen to send or cancel sending message. double tap on session screen takes back to list of sessions screen for that agent.
  double tap on sessions screen should take back to selection of agent screen. Double tap on agent screen or inital pairing screen should toggle glasses screen on or off. Create a
  detailed architecture doc in docs/ folder as well as execution prd doc along with UI invariants doc that need to be fully validated and detailed testing harness doc that will
  cover all the functionalities i described. Ask any questions for clarification if needed or for any important decision making
