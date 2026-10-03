package main

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"strings"

	kitagenthook "go.kenn.io/kit/agenthook"

	"go.kenn.io/roborev/internal/agenthook"
)

// Pi emits normalized events rather than a kit-managed native hook envelope.
// Reuse the regular handler for config, transport, and reminder instructions.
func runPiAgentHook(opts agenthook.Options, stdin io.Reader, stdout, stderr io.Writer) error {
	var payload jsontext.Value
	if err := json.UnmarshalRead(stdin, &payload); err != nil {
		return fmt.Errorf("decode Pi hook payload: %w", err)
	}
	var common kitagenthook.CommonInput
	if err := json.Unmarshal(payload, &common); err != nil {
		return fmt.Errorf("decode Pi hook payload: %w", err)
	}
	if strings.TrimSpace(common.SessionID) == "" {
		return fmt.Errorf("decode Pi hook payload: missing session_id")
	}
	handler := newRoborevAgentHookHandler(agenthook.AgentPi, opts, stderr)
	ctx := context.Background()
	var instruction string
	switch common.HookEventName {
	case kitagenthook.EventPreToolUse:
		var input kitagenthook.PreToolUseInput
		if err := json.Unmarshal(payload, &input); err != nil {
			return err
		}
		if _, err := handler.PreToolUse(ctx, input); err != nil {
			return err
		}
	case kitagenthook.EventPostToolUse:
		var input kitagenthook.PostToolUseInput
		if err := json.Unmarshal(payload, &input); err != nil {
			return err
		}
		output, err := handler.PostToolUse(ctx, input)
		if err != nil {
			return err
		}
		instruction = output.AdditionalContext
	case kitagenthook.EventStop:
		var input kitagenthook.StopInput
		if err := json.Unmarshal(payload, &input); err != nil {
			return err
		}
		output, err := handler.Stop(ctx, input)
		if err != nil {
			return err
		}
		instruction = output.Reason
	default:
		return fmt.Errorf("unsupported Pi hook event %q", common.HookEventName)
	}
	return json.MarshalWrite(stdout, struct {
		Context string `json:"context,omitempty"`
	}{Context: instruction})
}
