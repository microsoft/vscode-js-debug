function customDebuggerDescription(obj: any, defaultValue: string): string {
    if (obj.constructor.prototype === obj) {
        // object is a prototype
        if (obj.constructor.name) {
            throw new Error('awefawfwea');
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

class Fraction {
    public constructor(private readonly numerator: number, private readonly denominator: number) {}

    public customDescription(): string {
        return `${this.numerator}/${this.denominator}`;
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
