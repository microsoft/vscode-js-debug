setTimeout(
  () => console.log(`Hello from child ${process.argv[2]}! Options:`, process.env.NODE_OPTIONS),
  2000,
);
