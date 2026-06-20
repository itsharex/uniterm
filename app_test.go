package main

import (
	"reflect"
	"testing"
)

func TestParseWSLDistros_UTF16LE(t *testing.T) {
	raw := []byte{0xFF, 0xFE, 'U', 0, 'b', 0, 'u', 0, 'n', 0, 't', 0, 'u', 0, '\n', 0,
		'D', 0, 'e', 0, 'b', 0, 'i', 0, 'a', 0, 'n', 0, '\n', 0}
	got := parseWSLDistros(raw)
	want := []string{"Ubuntu", "Debian"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseWSLDistros() = %v, want %v", got, want)
	}
}

func TestParseWSLDistros_UTF8(t *testing.T) {
	raw := []byte("Ubuntu\n*Debian\n\ndocker-desktop-data\n")
	got := parseWSLDistros(raw)
	want := []string{"Ubuntu", "Debian"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseWSLDistros() = %v, want %v", got, want)
	}
}

func TestParseWSLDistros_Empty(t *testing.T) {
	got := parseWSLDistros(nil)
	if got != nil {
		t.Errorf("parseWSLDistros(nil) = %v, want nil", got)
	}
}
