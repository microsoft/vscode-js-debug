function doTest() {
  class Foo { bar() { return 42 } }
  function identity(a) { return a }
  identity(new Foo())
  identity(identity(new Foo().bar()))
}
