const defaultValue = `
                   Welcome to

    ░█▀█░█▀▀░█▀▀░▀█▀░█▀▀░█▀█░█▄█░█▀▀░█▀█░▀█▀
    ░█▀█░▀▀█░▀▀█░░█░░█░█░█░█░█░█░█▀▀░█░█░░█░
    ░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀░▀░▀▀▀░▀░▀░░▀░

    The _ultimate_ collaborative text editor!


                Getting started:`;
const stepOne = `
       1. Enter your mode (server/client): `;

const stepServerTwo = `
             2. Listen on port (8080): `;
const stepServerThree = `
         3. Ctrl/Cmd-O to start editing`;

const stepClientTwo = `
         2. Server address (host:port): `;

const stepClientThree = `
            3. Ctrl/Cmd-O to connect`;

module.exports = {
	defaultValue,
	stepOne,
	stepServerTwo,
	stepServerThree,
	stepClientTwo,
	stepClientThree,
};
