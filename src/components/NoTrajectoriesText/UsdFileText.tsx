import * as React from "react";

import styles from "../NoTrajectoriesText/style.css";

const UsdFileText = (): JSX.Element => {
    return (
        <div className={styles.container}>
            <h3>USD File Loaded</h3>
            <p>
                USD files display 3D geometry but do not include agent type
                data. Use the camera controls to navigate the scene.
            </p>
        </div>
    );
};

export default UsdFileText;
