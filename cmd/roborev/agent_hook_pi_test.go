package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPiAgentHookRejectsInvalidEvents(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload string
		wantErr string
	}{
		{name: "empty stdin", wantErr: "decode Pi hook payload"},
		{name: "missing session", payload: `{"hook_event_name":"Stop"}`, wantErr: "missing session_id"},
		{name: "blank session", payload: `{"session_id":" ","hook_event_name":"Stop"}`, wantErr: "missing session_id"},
		{name: "unknown event", payload: `{"session_id":"pi-1","hook_event_name":"Unknown"}`, wantErr: "unsupported Pi hook event"},
		{name: "missing event", payload: `{"session_id":"pi-1"}`, wantErr: "unsupported Pi hook event"},
		{name: "invalid shell input", payload: `{"session_id":"pi-1","hook_event_name":"PreToolUse","tool_input":[]}`, wantErr: "decode normalized tool input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			cmd := agentHookCmd()
			cmd.SetIn(strings.NewReader(tc.payload))
			cmd.SetOut(&stdout)
			cmd.SetErr(&stderr)
			cmd.SetArgs([]string{"run", "--agent", "pi", "--source=roborev-agent-hook"})
			err := cmd.Execute()
			require.ErrorContains(t, err, tc.wantErr)
			assert.NotContains(t, stdout.String(), `"context"`)
		})
	}
}
