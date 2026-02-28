package config

import (
	"reflect"
	"testing"
)

func TestConfigHasEnvconfigTags(t *testing.T) {
	typ := reflect.TypeOf(Config{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag := field.Tag.Get("envconfig")
		if tag == "" {
			t.Errorf("field %s missing envconfig tag", field.Name)
		}
	}
}

func TestConfigDefaults(t *testing.T) {
	typ := reflect.TypeOf(Config{})

	listenAddr, _ := typ.FieldByName("ListenAddr")
	if listenAddr.Tag.Get("default") != ":8080" {
		t.Error("ListenAddr should default to :8080")
	}

	logLevel, _ := typ.FieldByName("LogLevel")
	if logLevel.Tag.Get("default") != "info" {
		t.Error("LogLevel should default to info")
	}
}
