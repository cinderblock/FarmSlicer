// Drop-in replacement for three.js Clock without the deprecation warning.
// three.js r183+ deprecated Clock in favor of Timer, but @react-three/fiber
// v9 still instantiates it. R3F v10 migrates to Timer.
// https://github.com/pmndrs/react-three-fiber/issues/2688

class Clock {

	constructor( autoStart = true ) {

		this.autoStart = autoStart;
		this.startTime = 0;
		this.oldTime = 0;
		this.elapsedTime = 0;
		this.running = false;

	}

	start() {

		this.startTime = performance.now();
		this.oldTime = this.startTime;
		this.elapsedTime = 0;
		this.running = true;

	}

	stop() {

		this.getElapsedTime();
		this.running = false;
		this.autoStart = false;

	}

	getElapsedTime() {

		this.getDelta();
		return this.elapsedTime;

	}

	getDelta() {

		let diff = 0;

		if ( this.autoStart && ! this.running ) {

			this.start();
			return 0;

		}

		if ( this.running ) {

			const newTime = performance.now();
			diff = ( newTime - this.oldTime ) / 1000;
			this.oldTime = newTime;
			this.elapsedTime += diff;

		}

		return diff;

	}

}

export { Clock };
