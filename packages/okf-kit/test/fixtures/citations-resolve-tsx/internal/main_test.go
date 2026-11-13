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

func BenchmarkThing(b *testing.B) {
  for b.Loop() {
    work()
  }
}

func FuzzThing(f *testing.F) {
  f.Fuzz(func(t *testing.T, s string) {})
}

func Example() {
  fmt.Println("hi")
}
