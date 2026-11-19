package main

import "testing"

type DeploySuite struct{}

func (s *DeploySuite) TestRollout() {
	if 1 != 1 {
		s.Fail("nope")
	}
}

func TestTable(t *testing.T) {
	cases := []int{1, 2}
	for _, c := range cases {
		t.Run("case", func(t *testing.T) {
			if c < 0 {
				t.Fatal("neg")
			}
		})
	}
}

func TestSiblings(t *testing.T) {
	t.Run("first", func(t *testing.T) {
		work()
	})
	t.Run("second", func(t *testing.T) {
		work()
	})
}

func TestNested(t *testing.T) {
	t.Run("outer", func(t *testing.T) {
		t.Run("inner", func(t *testing.T) {
			work()
		})
	})
}

func TestNotAHead(t *testing.T) {
	x.Runner("nope", func() {})
	// t.Run("commented", func(t *testing.T) {})
	name := "t.Run(literal)"
	_ = name
}
