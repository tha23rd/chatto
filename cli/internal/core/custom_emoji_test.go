package core

import (
	"strings"
	"testing"
)

func TestValidateCustomEmojiName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "simple", input: "partyparrot", wantErr: false},
		{name: "with underscore and digit", input: "blob_wave2", wantErr: false},
		// A single "a" is intentionally NOT tested as valid: ":a:" is a real
		// gemoji shortcode, so it correctly collides. Use "_" for the 1-char
		// regex boundary instead.
		{name: "single underscore", input: "_", wantErr: false},
		{name: "max length 64", input: strings.Repeat("a", 64), wantErr: false},

		{name: "empty", input: "", wantErr: true},
		{name: "uppercase", input: "PartyParrot", wantErr: true},
		{name: "space", input: "party parrot", wantErr: true},
		{name: "punctuation", input: "party!", wantErr: true},
		{name: "colon wrapped", input: ":party:", wantErr: true},
		{name: "hyphen", input: "party-parrot", wantErr: true},
		{name: "too long 65", input: strings.Repeat("a", 65), wantErr: true},
		// Collides with the built-in gemoji vocabulary.
		{name: "gemoji collision smile", input: "smile", wantErr: true},
		{name: "gemoji collision thumbsup", input: "thumbsup", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateCustomEmojiName(tt.input)
			if tt.wantErr && err == nil {
				t.Fatalf("validateCustomEmojiName(%q) = nil, want error", tt.input)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateCustomEmojiName(%q) = %v, want nil", tt.input, err)
			}
		})
	}
}

// TestValidateCustomEmojiName_GemojiSanity guards the assumption behind the
// collision check: the reserved names really are in the built-in vocabulary.
func TestValidateCustomEmojiName_GemojiSanity(t *testing.T) {
	if !IsValidEmojiName("smile") {
		t.Fatal("expected \"smile\" to be a built-in gemoji shortcode")
	}
}
