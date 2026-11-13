package main

import "testing"

func TestMain(m *testing.M) {
  setup()
}

func TestThing(t *testing.T) {
  if 1 != 1 {
    t.Fatal("nope")
  }
}
