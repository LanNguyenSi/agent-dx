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

func TestSuiteRun(t *testing.T) {
	suite.Run(t, new(DeploySuite))
}

func (s DeploySuite) TestValueReceiver(t *testing.T) {
	s.Log("value receiver")
}

func (s DeploySuite) TestValueTwo() {
	s.Run("x", func() {
		work()
	})
}

func TestLookalikes(t *testing.T) {
	t.Run("first", func(t *testing.T) {
		work()
	})
	func TestX(t *testing.T) { // synthetic indented head look-alike
		work()
	}
	cmd.Run()
	x.Runner("nope", func() {})
}
