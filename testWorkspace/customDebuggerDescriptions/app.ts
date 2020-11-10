function customDebuggerDescription(obj: any, defaultValue: string): string {
  if (obj.constructor && obj.constructor.prototype === obj) {
    // object is a prototype
    if (obj.constructor.name) {
      return `Prototype of ${obj.constructor.name}`;
    } else {
      return defaultValue;
    }
  } else if (obj.customDescription && obj.customDescription instanceof Function) {
    return obj.customDescription();
  } else if (defaultValue.startsWith("class ")) {
    // just print class name without the constructor source code
    const className: string = defaultValue.split(" ", 2)[1];
    return `class ${className}`;
  } else {
    return defaultValue;
  }
}

(global as any).customDebuggerDescription = customDebuggerDescription;

function customPropertiesGenerator(obj: any): object {
  if (obj && obj.customPropertiesGenerator && obj.customPropertiesGenerator instanceof Function) {
    return obj.customPropertiesGenerator();
  } else {
    return obj;
  }
}

(global as any).customPropertiesGenerator = customPropertiesGenerator;

class Fraction {
  public constructor(private readonly numerator: number, private readonly denominator: number) { }

  public customDescription(): string {
    return `${this.numerator}/${this.denominator}`;
  }

  public floatValue(): number {
    return this.numerator / this.denominator;
  }

  public customPropertiesGenerator(): object {
    const properties: object = Object.create((this as any).__proto__);
    Object.assign(properties, { ...this, asRational: this.floatValue() });
    return properties;
  }
}

const fraction1: Fraction = new Fraction(2, 3);
const fraction2: Fraction = new Fraction(3, 4);
const fraction3: Fraction = new Fraction(5, 6);

console.log("Line 1");
console.log("Line 2");
console.log("Line 3");
console.log("Line 4");
console.log("Line 5");
console.log("Line 6");
console.log("Line 7");
console.log("Line 8");
