const express = require('express');
const server = express();

server.all('/', (req, res) => {
    res.send('¡Papuamigo sigue despierto y activo!');
});

function keepAlive() {
    server.listen(process.env.PORT || 3000, () => {
        console.log("Servidor Keep Alive listo y detectado por Render");
    });
}

module.exports = keepAlive;
